const express = require('express');
const router = express.Router();
const db = require('../db');
const { addSixMonths } = require('../utils/dates');

// Dropdown options for "Calibration description" — edit this array to add/remove choices
const DESCRIPTION_OPTIONS = ['One Day Service', 'Normal Service', 'Repair', 'Full Service', 'Selling'];

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
  // ("Done date (list wise)") once a serial number is picked.
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
    descriptionOptions: DESCRIPTION_OPTIONS,
    username: req.session.username,
    flash,
  });
});

router.post('/new', (req, res) => {
  const { equipment_id, description, done, status, done_date, repair, spare_part_replacement, repair_description } = req.body;

  if (!equipment_id) return res.redirect('/calibrations/new');

  const isDone = done === 'Yes';
  const isRepair = repair === 'Yes';

  db.prepare(`
    INSERT INTO calibrations (equipment_id, description, done, status, done_date, repair, spare_part_replacement, repair_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    equipment_id, description || '', isDone ? 'Yes' : 'No', status || '', done_date || null,
    isRepair ? 'Yes' : 'No',
    isRepair ? (spare_part_replacement || '') : null,
    isRepair ? (repair_description || '') : null
  );

  // Keep the equipment record's own calibration dates in sync when this
  // calibration is marked Done — same convention as the existing
  // "Mark Done Today" quick action on the dashboard (next date = +6 months).
  if (isDone && done_date) {
    const next_calibration_date = addSixMonths(done_date);
    db.prepare(`
      UPDATE equipment
      SET last_calibration_date = ?, next_calibration_date = ?, status = ?
      WHERE id = ?
    `).run(done_date, next_calibration_date, status || 'Completed', equipment_id);
  }

  req.session.flash = 'Calibration record saved.';
  res.redirect('/calibrations/new');
});

// Edit an existing calibration record
router.get('/:id/edit', (req, res) => {
  const calibration = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.equipment_type,
           customers.name AS customer_name
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    WHERE calibrations.id = ?
  `).get(req.params.id);

  if (!calibration) return res.redirect('/calibrations');

  res.render('calibrations/edit', {
    calibration,
    descriptionOptions: DESCRIPTION_OPTIONS,
    username: req.session.username,
  });
});

router.post('/:id/edit', (req, res) => {
  const { description, done, status, done_date, repair, spare_part_replacement, repair_description } = req.body;
  const isDone = done === 'Yes';
  const isRepair = repair === 'Yes';
  const { id } = req.params;

  const calibration = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(id);
  if (!calibration) return res.redirect('/calibrations');

  db.prepare(`
    UPDATE calibrations
    SET description = ?, done = ?, status = ?, done_date = ?,
        repair = ?, spare_part_replacement = ?, repair_description = ?
    WHERE id = ?
  `).run(
    description || '', isDone ? 'Yes' : 'No', status || '', done_date || null,
    isRepair ? 'Yes' : 'No',
    isRepair ? (spare_part_replacement || '') : null,
    isRepair ? (repair_description || '') : null,
    id
  );

  // Keep the equipment record's own calibration dates in sync, same as /new
  if (isDone && done_date) {
    const next_calibration_date = addSixMonths(done_date);
    db.prepare(`
      UPDATE equipment
      SET last_calibration_date = ?, next_calibration_date = ?, status = ?
      WHERE id = ?
    `).run(done_date, next_calibration_date, status || 'Completed', calibration.equipment_id);
  }

  req.session.flash = 'Calibration record updated.';
  res.redirect('/calibrations');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM calibrations WHERE id = ?').run(req.params.id);
  req.session.flash = 'Calibration record deleted.';
  res.redirect('/calibrations');
});

module.exports = router;