const express = require('express');
const router = express.Router();
const db = require('../db');
const { addSixMonths } = require('../utils/dates');

router.get('/new', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  res.render('equipment/form', { equipment: null, customers, username: req.session.username });
});

router.post('/new', (req, res) => {
  const { customer_id, brand, model, serial_number, last_calibration_date, status, notes } = req.body;
  const next_calibration_date = addSixMonths(last_calibration_date);
  db.prepare(`
    INSERT INTO equipment (customer_id, brand, model, serial_number, last_calibration_date, next_calibration_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer_id, brand, model, serial_number, last_calibration_date, next_calibration_date, status || 'Pending', notes);
  res.redirect('/');
});

router.get('/:id/edit', (req, res) => {
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  if (!equipment) return res.redirect('/');
  res.render('equipment/form', { equipment, customers, username: req.session.username });
});

router.post('/:id/edit', (req, res) => {
  const { customer_id, brand, model, serial_number, last_calibration_date, status, notes } = req.body;
  // Recalculate next calibration date automatically whenever the last calibration date changes
  const next_calibration_date = addSixMonths(last_calibration_date);
  db.prepare(`
    UPDATE equipment
    SET customer_id = ?, brand = ?, model = ?, serial_number = ?,
        last_calibration_date = ?, next_calibration_date = ?, status = ?, notes = ?
    WHERE id = ?
  `).run(customer_id, brand, model, serial_number, last_calibration_date, next_calibration_date, status, notes, req.params.id);
  res.redirect('/');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
  res.redirect('/');
});

// Quick action: mark calibration done today -> resets last date to today, next date auto +6 months
router.post('/:id/mark-done', (req, res) => {
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
