const express = require('express');
const router = express.Router();
const db = require('../db');
const { syncEquipmentCalibrationDates } = require('../utils/syncEquipmentCalibration');

// Calibration Description is a user-extendable dropdown, same pattern as
// Equipment Type / Brand / Model on the equipment form — stored in the
// shared dropdown_options table so anything typed as "+ Add new" sticks
// around for future use.
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

function resolveOptionValue(selectValue, newValue, fieldName) {
  if (selectValue === '__new__') {
    const trimmed = (newValue || '').trim();
    if (trimmed) addOptionIfMissing(fieldName, trimmed);
    return trimmed;
  }
  return selectValue || '';
}

// Pulls repeatable {description[], amount[]} array pairs out of the
// request body for one line-item group (services / spare parts / repairs),
// skipping any row where both fields were left empty.
function collectLineItems(descriptions, amounts) {
  const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const descArr = toArray(descriptions);
  const amtArr = toArray(amounts);

  return descArr
    .map((desc, i) => ({
      description: (desc || '').trim(),
      amount: amtArr[i] !== undefined && amtArr[i] !== '' ? Number(amtArr[i]) : null,
    }))
    .filter((item) => item.description !== '' || item.amount !== null);
}

function insertLineItems(calibrationId, itemType, items) {
  if (items.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO calibration_line_items (calibration_id, item_type, description, amount)
    VALUES (?, ?, ?, ?)
  `);
  items.forEach((item) => insert.run(calibrationId, itemType, item.description, item.amount));
}

// List all calibration records, most recent first
router.get('/', (req, res) => {
  const calibrations = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.equipment_type,
           customers.name AS customer_name
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY calibrations.id DESC
  `).all();

  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render('calibrations/list', {
    calibrations,
    username: req.session.username,
    flash,
  });
});

router.get('/new', (req, res) => {
  const equipmentList = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.company AS customer_company
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY equipment.serial_number ASC
  `).all();

  // Past "done" dates per equipment, so the form can show calibration history
  // once a serial number is picked.
  const pastCalibrations = db.prepare(`
    SELECT equipment_id, done_date FROM calibrations
    WHERE done_date IS NOT NULL AND done_date != ''
    ORDER BY done_date DESC
  `).all();

  const doneDatesByEquipment = {};
  pastCalibrations.forEach((row) => {
    if (!doneDatesByEquipment[row.equipment_id]) doneDatesByEquipment[row.equipment_id] = [];
    doneDatesByEquipment[row.equipment_id].push(row.done_date);
  });

  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render('calibrations/form', {
    equipmentList,
    doneDatesByEquipment,
    descriptionOptions: getOptions('calibration_description'),
    username: req.session.username,
    flash,
  });
});

router.post('/new', (req, res) => {
  const {
    equipment_id, description, description_new, done, status, done_date, repair,
  } = req.body;

  if (!equipment_id) return res.redirect('/calibrations/new');

  const isDone = done === 'Yes';
  const isRepair = repair === 'Yes';
  const finalDescription = resolveOptionValue(description, description_new, 'calibration_description');

  const insertCalibration = db.prepare(`
    INSERT INTO calibrations (equipment_id, description, done, status, done_date, repair)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = insertCalibration.run(
    equipment_id, finalDescription, isDone ? 'Yes' : 'No', status || '', done_date || null,
    isRepair ? 'Yes' : 'No'
  );
  const calibrationId = result.lastInsertRowid;

  // Itemized line items — each is optional and repeatable on the form.
  if (isDone) {
    insertLineItems(calibrationId, 'service', collectLineItems(req.body.service_description, req.body.service_amount));
  }
  if (isRepair) {
    insertLineItems(calibrationId, 'spare_part', collectLineItems(req.body.spare_part_description, req.body.spare_part_amount));
    insertLineItems(calibrationId, 'repair', collectLineItems(req.body.repair_item_description, req.body.repair_item_amount));
  }

  // Keep the equipment record's own calibration dates in sync — always
  // recomputed from the TRUE most recent Done record on file, not just
  // this one, so this stays correct no matter what order records are added.
  syncEquipmentCalibrationDates(equipment_id);

  req.session.flash = 'Calibration record saved.';
  res.redirect('/calibrations/new');
});

// Edit an existing calibration record
router.get('/:id/edit', (req, res) => {
  const calibration = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.equipment_type,
           equipment.model, customers.name AS customer_name, customers.company AS customer_company
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    WHERE calibrations.id = ?
  `).get(req.params.id);

  if (!calibration) return res.redirect('/calibrations');

  const lineItems = db.prepare(`
    SELECT * FROM calibration_line_items WHERE calibration_id = ? ORDER BY id ASC
  `).all(req.params.id);

  res.render('calibrations/edit', {
    calibration,
    services: lineItems.filter((i) => i.item_type === 'service'),
    spareParts: lineItems.filter((i) => i.item_type === 'spare_part'),
    repairItems: lineItems.filter((i) => i.item_type === 'repair'),
    descriptionOptions: getOptions('calibration_description'),
    username: req.session.username,
  });
});

router.post('/:id/edit', (req, res) => {
  const {
    description, description_new, done, status, done_date, repair,
  } = req.body;
  const isDone = done === 'Yes';
  const isRepair = repair === 'Yes';
  const { id } = req.params;

  const calibration = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(id);
  if (!calibration) return res.redirect('/calibrations');

  const finalDescription = resolveOptionValue(description, description_new, 'calibration_description');

  db.prepare(`
    UPDATE calibrations
    SET description = ?, done = ?, status = ?, done_date = ?, repair = ?
    WHERE id = ?
  `).run(finalDescription, isDone ? 'Yes' : 'No', status || '', done_date || null, isRepair ? 'Yes' : 'No', id);

  // Simplest correct approach for repeatable line items: wipe and re-insert
  // whatever was submitted, rather than trying to diff old vs new rows.
  db.prepare('DELETE FROM calibration_line_items WHERE calibration_id = ?').run(id);
  if (isDone) {
    insertLineItems(id, 'service', collectLineItems(req.body.service_description, req.body.service_amount));
  }
  if (isRepair) {
    insertLineItems(id, 'spare_part', collectLineItems(req.body.spare_part_description, req.body.spare_part_amount));
    insertLineItems(id, 'repair', collectLineItems(req.body.repair_item_description, req.body.repair_item_amount));
  }

  // Keep the equipment record's own calibration dates in sync — always
  // recomputed from the TRUE most recent Done record on file. This is the
  // fix: editing an OLD historical calibration record no longer overwrites
  // the equipment's real next-due date with a stale/older value.
  syncEquipmentCalibrationDates(calibration.equipment_id);

  req.session.flash = 'Calibration record updated.';
  res.redirect('/calibrations');
});

router.post('/:id/delete', (req, res) => {
  const calibration = db.prepare('SELECT equipment_id FROM calibrations WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM calibrations WHERE id = ?').run(req.params.id);

  // If the deleted record was the most recent Done calibration, the
  // equipment's next-due date needs to fall back to whatever is now the
  // true most recent one on file (or clear, if none remain).
  if (calibration) {
    syncEquipmentCalibrationDates(calibration.equipment_id);
  }

  req.session.flash = 'Calibration record deleted.';
  res.redirect('/calibrations');
});

module.exports = router;