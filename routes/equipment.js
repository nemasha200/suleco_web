const express = require('express');
const router = express.Router();
const db = require('../db');

// Warranty periods stay as a fixed list (unlikely to need user-added values).
const WARRANTY_OPTIONS = [6, 12, 24, 30, 36, 42, 48];

// Equipment Type / Brand / Model are user-extendable — stored in the
// dropdown_options table so anything added through the form is remembered
// and shows up in every dropdown from then on.
function getOptions(fieldName) {
  return db.prepare(
    'SELECT value FROM dropdown_options WHERE field_name = ? ORDER BY value COLLATE NOCASE ASC'
  ).all(fieldName).map(r => r.value);
}

function addOptionIfMissing(fieldName, value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return;
  db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name, value) VALUES (?, ?)').run(fieldName, trimmed);
}

// Resolves a row's submitted value for a user-extendable field: if the
// select was set to "__new__", use (and remember) the typed new value instead.
function resolveOptionValue(selectValue, newValue, fieldName) {
  if (selectValue === '__new__') {
    const trimmed = (newValue || '').trim();
    if (trimmed) addOptionIfMissing(fieldName, trimmed);
    return trimmed;
  }
  return selectValue || '';
}

router.get('/new', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  res.render('equipment/form', {
    equipment: null,
    customers,
    equipmentTypes: getOptions('equipment_type'),
    brands: getOptions('brand'),
    models: getOptions('model'),
    warrantyOptions: WARRANTY_OPTIONS,
    username: req.session.username,
  });
});

// Batch insert: one customer, one or more equipment rows, each with its OWN
// "sold by us" / purchase date / warranty info (set per equipment item, not shared).
router.post('/new', (req, res) => {
  const { customer_id } = req.body;

  const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const equipmentTypesInput = toArray(req.body.equipment_type);
  const equipmentTypeNewInput = toArray(req.body.equipment_type_new);
  const brandsInput = toArray(req.body.brand);
  const brandNewInput = toArray(req.body.brand_new);
  const modelsInput = toArray(req.body.model);
  const modelNewInput = toArray(req.body.model_new);
  const serialNumbers = toArray(req.body.serial_number);
  const soldByUsInput = toArray(req.body.sold_by_us);
  const purchaseDates = toArray(req.body.purchase_date);
  const warrantyPeriods = toArray(req.body.warranty_period_months);

  const insert = db.prepare(`
    INSERT INTO equipment
      (customer_id, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(
        customer_id,
        row.equipment_type,
        row.brand,
        row.model,
        row.serial_number,
        row.sold_by_us,
        row.purchase_date,
        row.warranty_period_months,
        'Pending'
      );
    }
  });

  const rows = equipmentTypesInput
    .map((typeVal, i) => {
      const isSold = soldByUsInput[i] === 'Yes';
      return {
        equipment_type: resolveOptionValue(typeVal, equipmentTypeNewInput[i], 'equipment_type'),
        brand: resolveOptionValue(brandsInput[i], brandNewInput[i], 'brand'),
        model: resolveOptionValue(modelsInput[i], modelNewInput[i], 'model'),
        serial_number: serialNumbers[i] || '',
        sold_by_us: soldByUsInput[i] || 'No',
        purchase_date: isSold ? (purchaseDates[i] || null) : null,
        warranty_period_months: isSold ? (warrantyPeriods[i] || null) : null,
      };
    })
    .filter((row) => row.serial_number.trim() !== '');

  if (rows.length > 0) {
    insertMany(rows);
  }

  res.redirect('/');
});

router.get('/:id/view', (req, res) => {
  const equipment = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.company AS customer_company,
           customers.phone AS customer_phone, customers.email AS customer_email
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    WHERE equipment.id = ?
  `).get(req.params.id);

  if (!equipment) return res.redirect('/');

  const calibrations = db.prepare(`
    SELECT * FROM calibrations WHERE equipment_id = ? ORDER BY id DESC
  `).all(req.params.id);

  res.render('equipment/view', {
    equipment,
    calibrations,
    username: req.session.username,
  });
});

router.get('/:id/edit', (req, res) => {
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  if (!equipment) return res.redirect('/');
  res.render('equipment/form', {
    equipment,
    customers,
    equipmentTypes: getOptions('equipment_type'),
    brands: getOptions('brand'),
    models: getOptions('model'),
    warrantyOptions: WARRANTY_OPTIONS,
    username: req.session.username,
  });
});

router.post('/:id/edit', (req, res) => {
  const { customer_id } = req.body;

  // The edit form uses the same per-row array-style field names as the add
  // form (equipment_type[], sold_by_us[], etc.), even though there's only
  // one row here — so pull the first (only) entry out of each array.
  const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const equipment_type = resolveOptionValue(
    toArray(req.body.equipment_type)[0], toArray(req.body.equipment_type_new)[0], 'equipment_type'
  );
  const brand = resolveOptionValue(
    toArray(req.body.brand)[0], toArray(req.body.brand_new)[0], 'brand'
  );
  const model = resolveOptionValue(
    toArray(req.body.model)[0], toArray(req.body.model_new)[0], 'model'
  );
  const serial_number = toArray(req.body.serial_number)[0] || '';
  const sold_by_us = toArray(req.body.sold_by_us)[0] || 'No';

  const isSold = sold_by_us === 'Yes';
  const purchase_date = isSold ? (toArray(req.body.purchase_date)[0] || null) : null;
  const warranty_period_months = isSold ? (toArray(req.body.warranty_period_months)[0] || null) : null;

  db.prepare(`
    UPDATE equipment
    SET customer_id = ?, equipment_type = ?, brand = ?, model = ?, serial_number = ?,
        sold_by_us = ?, purchase_date = ?, warranty_period_months = ?
    WHERE id = ?
  `).run(customer_id, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months, req.params.id);

  res.redirect('/');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
  res.redirect('/');
});

// Quick action: mark calibration done today -> resets last date to today, next date auto +6 months
router.post('/:id/mark-done', (req, res) => {
  const { addSixMonths } = require('../utils/dates');
  const today = new Date().toISOString().split('T')[0];
  const next_calibration_date = addSixMonths(today);
  db.prepare(`
    UPDATE equipment
    SET last_calibration_date = ?, next_calibration_date = ?, status = 'Completed'
    WHERE id = ?
  `).run(today, next_calibration_date, req.params.id);
  res.redirect('/');
});

module.exports = router;