const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const {
  ensureEquipmentToken, publicEquipmentUrl, qrPngBuffer, qrDataUrl, safeFileName,
} = require('../utils/qr');

// Warranty periods stay as a fixed list (unlikely to need user-added values).
const WARRANTY_OPTIONS = [6, 12, 24, 30, 36, 42, 48];

// The three business divisions an instrument can belong to. Kept as a fixed
// list rather than a dropdown_options row: these are company divisions, not
// free-form data the office should be adding to from a form.
const COMPANY_CATEGORIES = ['Survey', 'Lab', 'Drones'];

// Guard against a hand-crafted POST putting junk in the column. Anything not
// in the list is stored as NULL, which the dashboard renders as "—".
function resolveCompanyCategory(value) {
  return COMPANY_CATEGORIES.includes(value) ? value : null;
}

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
    companyCategories: COMPANY_CATEGORIES,
    username: req.session.username,
  });
});

// Batch insert: one customer, one or more equipment rows, each with its OWN
// "sold by us" / purchase date / warranty info (set per equipment item, not shared).
router.post('/new', (req, res) => {
  const { customer_id } = req.body;

  // One category per submission, applied to every item in the batch — unlike
  // the per-item fields below, this comes in as a single value, not an array.
  const company_category = resolveCompanyCategory(req.body.company_category);

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

  // response_token doubles as the QR scan key, so every new row gets one at
  // insert time. (db.js also backfills older rows on startup, but generating
  // it here means a brand-new item can have its QR printed immediately.)
  const insert = db.prepare(`
    INSERT INTO equipment
      (customer_id, company_category, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months, status, response_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(
        customer_id,
        company_category,
        row.equipment_type,
        row.brand,
        row.model,
        row.serial_number,
        row.sold_by_us,
        row.purchase_date,
        row.warranty_period_months,
        'Pending',
        crypto.randomBytes(16).toString('hex')
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

router.get('/:id/view', async (req, res) => {
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

  // QR block for this instrument — shown inline so it can be checked and
  // printed straight from this page.
  let qrImage = null;
  let scanUrl = null;
  try {
    const token = ensureEquipmentToken(equipment.id);
    scanUrl = publicEquipmentUrl(req, token);
    qrImage = await qrDataUrl(scanUrl);
  } catch (err) {
    console.error('QR generation failed for equipment view:', err);
  }

  res.render('equipment/view', {
    equipment,
    calibrations,
    qrImage,
    scanUrl,
    username: req.session.username,
  });
});

// Direct QR download for a piece of equipment (used by the equipment page and
// available anywhere you have the equipment id rather than a calibration id).
router.get('/:id/qr.png', async (req, res) => {
  const equipment = db.prepare('SELECT id, serial_number FROM equipment WHERE id = ?').get(req.params.id);
  if (!equipment) return res.status(404).send('Equipment not found.');

  try {
    const token = ensureEquipmentToken(equipment.id);
    const url = publicEquipmentUrl(req, token);
    const png = await qrPngBuffer(url);
    const fileName = `QR_${safeFileName(equipment.serial_number, 'equipment')}.png`;

    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Content-Disposition',
      req.query.inline === '1' ? `inline; filename="${fileName}"` : `attachment; filename="${fileName}"`
    );
    res.send(png);
  } catch (err) {
    console.error('QR generation failed:', err);
    res.status(500).send('Could not generate QR code.');
  }
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
    companyCategories: COMPANY_CATEGORIES,
    username: req.session.username,
  });
});

router.post('/:id/edit', (req, res) => {
  const { customer_id } = req.body;
  const company_category = resolveCompanyCategory(req.body.company_category);

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
    SET customer_id = ?, company_category = ?, equipment_type = ?, brand = ?, model = ?, serial_number = ?,
        sold_by_us = ?, purchase_date = ?, warranty_period_months = ?
    WHERE id = ?
  `).run(customer_id, company_category, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months, req.params.id);

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