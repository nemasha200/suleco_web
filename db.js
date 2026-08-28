const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'calibration.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  equipment_type TEXT,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  sold_by_us TEXT DEFAULT 'No',
  purchase_date TEXT,
  warranty_period_months INTEGER,
  last_calibration_date TEXT,
  next_calibration_date TEXT,
  status TEXT DEFAULT 'Pending',
  last_notified_date TEXT,
  reminded_for_due_date TEXT,
  response_token TEXT,
  customer_response TEXT,
  response_note TEXT,
  response_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  customer_name TEXT,
  channel TEXT,        -- 'email' or 'sms'
  target TEXT,         -- the email/phone it was sent to
  status TEXT,         -- 'sent', 'failed', 'skipped'
  detail TEXT,
  sent_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  description TEXT,     -- 'One Day Service' / 'Normal Service' / 'Repair' / 'Full Service' / 'Selling'
  done TEXT DEFAULT 'No',   -- 'Yes' or 'No'
  status TEXT,           -- free-typed status note
  done_date TEXT,
  repair TEXT DEFAULT 'No',            -- 'Yes' or 'No'
  spare_part_replacement TEXT,         -- only meaningful when repair = 'Yes'
  repair_description TEXT,             -- only meaningful when repair = 'Yes'
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dropdown_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field_name TEXT NOT NULL,   -- 'equipment_type' | 'brand' | 'model' | 'calibration_description'
  value TEXT NOT NULL,
  UNIQUE(field_name, value)
);

CREATE TABLE IF NOT EXISTS calibration_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calibration_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,     -- 'service' | 'spare_part' | 'repair'
  description TEXT,
  amount REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (calibration_id) REFERENCES calibrations(id) ON DELETE CASCADE
);
`);

// ---- Migration safety net for databases created by earlier versions of this app ----
const equipmentCols = db.prepare("PRAGMA table_info(equipment)").all().map(c => c.name);

// Add any newer columns that a pre-existing DB might be missing
const addColumnIfMissing = (name, ddl) => {
  if (!equipmentCols.includes(name)) {
    db.exec(`ALTER TABLE equipment ADD COLUMN ${ddl}`);
    equipmentCols.push(name);
  }
};
addColumnIfMissing('equipment_type', 'equipment_type TEXT');
addColumnIfMissing('model', 'model TEXT');
addColumnIfMissing('sold_by_us', "sold_by_us TEXT DEFAULT 'No'");
addColumnIfMissing('purchase_date', 'purchase_date TEXT');
addColumnIfMissing('warranty_period_months', 'warranty_period_months INTEGER');
addColumnIfMissing('last_notified_date', 'last_notified_date TEXT');
addColumnIfMissing('reminded_for_due_date', 'reminded_for_due_date TEXT');
addColumnIfMissing('response_token', 'response_token TEXT');
addColumnIfMissing('customer_response', 'customer_response TEXT');
addColumnIfMissing('response_note', 'response_note TEXT');
addColumnIfMissing('response_at', 'response_at TEXT');

// Same safety net, but for the calibrations table (new repair fields).
const calibrationCols = db.prepare("PRAGMA table_info(calibrations)").all().map(c => c.name);
const addCalibrationColumnIfMissing = (name, ddl) => {
  if (!calibrationCols.includes(name)) {
    db.exec(`ALTER TABLE calibrations ADD COLUMN ${ddl}`);
    calibrationCols.push(name);
  }
};
addCalibrationColumnIfMissing('repair', "repair TEXT DEFAULT 'No'");
addCalibrationColumnIfMissing('spare_part_replacement', 'spare_part_replacement TEXT');
addCalibrationColumnIfMissing('repair_description', 'repair_description TEXT');

// Historical cleanup: very old versions of this app had a redundant 'notes'
// column that's no longer used anywhere. If a database still has it, rebuild
// the table without it. NOTE: 'model' is now a genuine, permanent field (see
// addColumnIfMissing above) — any existing model data is simply kept as-is,
// not folded into equipment_type like an earlier migration used to do.
if (equipmentCols.includes('notes')) {
  db.exec('PRAGMA foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE equipment_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        equipment_type TEXT,
        brand TEXT,
        model TEXT,
        serial_number TEXT,
        sold_by_us TEXT DEFAULT 'No',
        purchase_date TEXT,
        warranty_period_months INTEGER,
        last_calibration_date TEXT,
        next_calibration_date TEXT,
        status TEXT DEFAULT 'Pending',
        last_notified_date TEXT,
        reminded_for_due_date TEXT,
        response_token TEXT,
        customer_response TEXT,
        response_note TEXT,
        response_at TEXT,
        created_at TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      INSERT INTO equipment_new
        (id, customer_id, equipment_type, brand, model, serial_number, sold_by_us,
         purchase_date, warranty_period_months, last_calibration_date,
         next_calibration_date, status, last_notified_date, reminded_for_due_date,
         response_token, customer_response, response_note, response_at, created_at)
      SELECT
        id, customer_id, equipment_type, brand, model, serial_number, sold_by_us,
        purchase_date, warranty_period_months, last_calibration_date,
        next_calibration_date, status, last_notified_date, reminded_for_due_date,
        response_token, customer_response, response_note, response_at, created_at
      FROM equipment;
    `);

    db.exec('DROP TABLE equipment;');
    db.exec('ALTER TABLE equipment_new RENAME TO equipment;');
  });
  migrate();
  db.exec('PRAGMA foreign_keys = ON');
}

// Every piece of equipment needs a unique response_token so the "click to
// respond" link in reminder messages works. Backfill any rows that don't
// have one yet (new rows get one automatically at insert time — see
// routes/equipment.js). Runs last, after any table rebuild above, so it
// always operates on the table's final shape.
const crypto = require('crypto');
const rowsMissingToken = db.prepare("SELECT id FROM equipment WHERE response_token IS NULL OR response_token = ''").all();
if (rowsMissingToken.length > 0) {
  const setToken = db.prepare('UPDATE equipment SET response_token = ? WHERE id = ?');
  rowsMissingToken.forEach((row) => {
    setToken.run(crypto.randomBytes(16).toString('hex'), row.id);
  });
}

// Seed the user-extendable dropdown option lists (Equipment Type / Brand /
// Model), only the first time — after that, whatever values exist (including
// any the user has added through the app) are left alone.
const insertOption = db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name, value) VALUES (?, ?)');
const seedOptionsIfEmpty = (fieldName, values) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM dropdown_options WHERE field_name = ?').get(fieldName).c;
  if (count === 0) values.forEach(v => insertOption.run(fieldName, v));
};

seedOptionsIfEmpty('equipment_type', ['Auto Level', 'Total Station', 'TL', 'DL']);
seedOptionsIfEmpty('brand', ['Topcon', 'Leica', 'South', 'Stonex', 'Sokkia']);
seedOptionsIfEmpty('model', ['GS', 'WS', 'WP', 'S900']);
seedOptionsIfEmpty('calibration_description', ['One Day Service', 'Normal Service', 'Repair', 'Full Service', 'Selling']);

// One-time seed so the app isn't empty on first run
const count = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
if (count === 0) {
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, company, phone, email) VALUES (?, ?, ?, ?)'
  );
  const insertEquipment = db.prepare(`
    INSERT INTO equipment (customer_id, equipment_type, brand, serial_number, last_calibration_date, next_calibration_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const c1 = insertCustomer.run('Lal Constructions', 'Lal Constructions', '703010152', '').lastInsertRowid;
  const c2 = insertCustomer.run('Survey Department', 'Survey Department', '', '').lastInsertRowid;

  insertEquipment.run(c1, 'ATB4A', 'Topcon', 'WP193069', '2026-01-07', '2026-07-07', 'Pending');
  insertEquipment.run(c2, 'Sprinter 150m', 'Leica', '2118744', '2025-11-04', '2026-05-04', 'Overdue');
}

module.exports = db;