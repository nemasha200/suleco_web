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
  phone2 TEXT,          -- optional second contact number
  email TEXT,
  email2 TEXT,          -- optional second email address
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  company_category TEXT,   -- 'Survey' | 'Lab' | 'Drones'
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

-- One row per reminder SWEEP (not per message). This is the audit trail that
-- proves the 9 AM job actually ran on a given day, and what it did. The
-- dashboard reads the newest unseen automatic row to show its popup.
CREATE TABLE IF NOT EXISTS notification_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,        -- YYYY-MM-DD in the configured timezone
  trigger_type TEXT NOT NULL,    -- 'scheduled' | 'catchup' | 'manual'
  started_at TEXT,
  finished_at TEXT,
  checked INTEGER DEFAULT 0,
  notified INTEGER DEFAULT 0,
  email_sent INTEGER DEFAULT 0,
  email_failed INTEGER DEFAULT 0,
  sms_sent INTEGER DEFAULT 0,
  sms_failed INTEGER DEFAULT 0,
  recipients TEXT,               -- JSON: who was contacted and with what result
  error TEXT,
  seen INTEGER DEFAULT 0         -- 0 = popup not shown to admin yet
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
// SQLite will not accept a non-constant default (datetime('now')) in ALTER
// TABLE, so this goes on with no default and the insert sets it explicitly.
// Rows that existed before the column was added keep NULL here.
addColumnIfMissing('created_at', 'created_at TEXT');
addColumnIfMissing('purchase_date', 'purchase_date TEXT');
addColumnIfMissing('warranty_period_months', 'warranty_period_months INTEGER');
addColumnIfMissing('last_notified_date', 'last_notified_date TEXT');
addColumnIfMissing('reminded_for_due_date', 'reminded_for_due_date TEXT');
addColumnIfMissing('response_token', 'response_token TEXT');
addColumnIfMissing('customer_response', 'customer_response TEXT');
addColumnIfMissing('response_note', 'response_note TEXT');
addColumnIfMissing('response_at', 'response_at TEXT');
// Survey / Lab / Drones — set on the Add Equipment form, shown on the
// dashboard. Left NULL on rows added before this column existed; those show
// as "—" until the item is edited.
addColumnIfMissing('company_category', 'company_category TEXT');

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

// ---- Three-stage service workflow (Check In -> Approval -> Service) ----
// A calibration record is now created at check-in and completed later, so it
// carries the stage it has reached plus the fields each stage collects.
addCalibrationColumnIfMissing('stage', "stage TEXT DEFAULT 'checkin'");
addCalibrationColumnIfMissing('check_in_date', 'check_in_date TEXT');
addCalibrationColumnIfMissing('equipment_return', "equipment_return TEXT DEFAULT 'No'");
addCalibrationColumnIfMissing('quotation_sent', "quotation_sent TEXT DEFAULT 'No'");
addCalibrationColumnIfMissing('po_received', "po_received TEXT DEFAULT 'No'");
addCalibrationColumnIfMissing('approved_at', 'approved_at TEXT');
addCalibrationColumnIfMissing('technicians', 'technicians TEXT');

// Fixed rupee discount applied to a service bill before SSCL and VAT.
addCalibrationColumnIfMissing('discount', 'discount REAL DEFAULT 0');

// Approval is ticked off over several days, so we note when it was last
// saved — separate from approved_at, which marks when service actually began.
addCalibrationColumnIfMissing('approval_updated_at', 'approval_updated_at TEXT');

// Each approval box records the date it was ticked, so the card shows when a
// quotation went out or a PO landed rather than just that it did.
addCalibrationColumnIfMissing('equipment_return_date', 'equipment_return_date TEXT');
addCalibrationColumnIfMissing('quotation_sent_date', 'quotation_sent_date TEXT');
addCalibrationColumnIfMissing('po_received_date', 'po_received_date TEXT');

// Released back to the customer without being serviced: the job ends at
// approval. It keeps its record in Services but leaves the in-progress queue,
// because nobody is going to work on it.
addCalibrationColumnIfMissing('released_without_service', "released_without_service TEXT DEFAULT 'No'");
addCalibrationColumnIfMissing('released_date', 'released_date TEXT');

// Records that existed before the workflow did are finished jobs, not
// half-started ones — mark them complete so they don't show up as pending.
db.prepare("UPDATE calibrations SET stage = 'done' WHERE stage IS NULL OR stage = ''").run();

// Same safety net for the customers table. Some clients give a second contact
// number and/or a second email; both are optional and reminders go to every
// one that's filled in (see utils/scheduler.js).
const customerCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
const addCustomerColumnIfMissing = (name, ddl) => {
  if (!customerCols.includes(name)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${ddl}`);
    customerCols.push(name);
  }
};
addCustomerColumnIfMissing('phone2', 'phone2 TEXT');
addCustomerColumnIfMissing('email2', 'email2 TEXT');

// Historical cleanup: very old versions of this app had a redundant 'notes'
// column that's no longer used anywhere. If a database still has it, rebuild
// the table without it. NOTE: 'model' is now a genuine, permanent field (see
// addColumnIfMissing above) — any existing model data is simply kept as-is,
// not folded into equipment_type like an earlier migration used to do.
//
// IMPORTANT: this rebuild lists every column explicitly, so any column added
// above must also be added here — otherwise a database old enough to still
// have 'notes' would silently lose it during the rebuild.
if (equipmentCols.includes('notes')) {
  db.exec('PRAGMA foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE equipment_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        company_category TEXT,
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
        (id, customer_id, company_category, equipment_type, brand, model, serial_number, sold_by_us,
         purchase_date, warranty_period_months, last_calibration_date,
         next_calibration_date, status, last_notified_date, reminded_for_due_date,
         response_token, customer_response, response_note, response_at, created_at)
      SELECT
        id, customer_id, company_category, equipment_type, brand, model, serial_number, sold_by_us,
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

// Technicians for the Group 3 dropdown. Seeded only when the list is empty,
// like the others — so a name deleted through the app stays deleted.
seedOptionsIfEmpty('technician', ['Maulith', 'Sanjaya', 'Chalaka', 'Tharaka']);

// One-time seed so the app isn't empty on first run
const count = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
if (count === 0) {
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, company, phone, email) VALUES (?, ?, ?, ?)'
  );
  const insertEquipment = db.prepare(`
    INSERT INTO equipment (customer_id, company_category, equipment_type, brand, serial_number, last_calibration_date, next_calibration_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const c1 = insertCustomer.run('Lal Constructions', 'Lal Constructions', '703010152', '').lastInsertRowid;
  const c2 = insertCustomer.run('Survey Department', 'Survey Department', '', '').lastInsertRowid;

  insertEquipment.run(c1, 'Survey', 'ATB4A', 'Topcon', 'WP193069', '2026-01-07', '2026-07-07', 'Pending');
  insertEquipment.run(c2, 'Survey', 'Sprinter 150m', 'Leica', '2118744', '2025-11-04', '2026-05-04', 'Overdue');
}

module.exports = db;