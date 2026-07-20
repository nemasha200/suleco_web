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
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  last_calibration_date TEXT,
  next_calibration_date TEXT,
  status TEXT DEFAULT 'Pending',
  notes TEXT,
  last_notified_date TEXT,
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
`);

// Migration safety net: add the column if upgrading an existing DB that predates this feature
const equipmentCols = db.prepare("PRAGMA table_info(equipment)").all().map(c => c.name);
if (!equipmentCols.includes('last_notified_date')) {
  db.exec('ALTER TABLE equipment ADD COLUMN last_notified_date TEXT');
}

// One-time seed so the app isn't empty on first run
const count = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
if (count === 0) {
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, company, phone, email) VALUES (?, ?, ?, ?)'
  );
  const insertEquipment = db.prepare(`
    INSERT INTO equipment (customer_id, brand, model, serial_number, last_calibration_date, next_calibration_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const c1 = insertCustomer.run('Lal Constructions', 'Lal Constructions', '703010152', '').lastInsertRowid;
  const c2 = insertCustomer.run('Survey Department', 'Survey Department', '', '').lastInsertRowid;

  insertEquipment.run(c1, 'Topcon', 'ATB4A', 'WP193069', '2026-01-07', '2026-07-07', 'Pending');
  insertEquipment.run(c2, 'Leica', 'Sprinter 150m', '2118744', '2025-11-04', '2026-05-04', 'Overdue');
}

module.exports = db;
