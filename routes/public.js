const express = require('express');
const router = express.Router();
const db = require('../db');
const { daysUntil, calibrationBadge } = require('../utils/dates');

// ---------------------------------------------------------------------------
// PUBLIC ROUTE — deliberately NOT behind requireLogin.
//
// This is what a phone opens after scanning the QR sticker on an instrument.
// Whoever scans it (a technician in the field, the customer, a site engineer)
// won't have an admin session, so the page has to be reachable without one.
//
// Access control is by the unguessable 128-bit token in the URL: you can only
// see a record if you're physically holding the equipment the sticker is on.
// The page is read-only — no edit, delete or add controls anywhere on it.
// ---------------------------------------------------------------------------

router.get('/q/:token', (req, res) => {
  const token = (req.params.token || '').trim();

  const equipment = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.company AS customer_company,
           customers.phone AS customer_phone, customers.email AS customer_email
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    WHERE equipment.response_token = ?
  `).get(token);

  if (!equipment) {
    return res.status(404).render('public/not-found');
  }

  const calibrations = db.prepare(`
    SELECT * FROM calibrations
    WHERE equipment_id = ?
    ORDER BY (done_date IS NULL OR done_date = ''), done_date DESC, id DESC
  `).all(equipment.id);

  // Pull every line item for this equipment's calibrations in one query, then
  // group them per calibration id — avoids running a query inside a loop.
  const calibrationIds = calibrations.map((c) => c.id);
  let itemsByCalibration = {};

  if (calibrationIds.length > 0) {
    const placeholders = calibrationIds.map(() => '?').join(',');
    const lineItems = db.prepare(`
      SELECT * FROM calibration_line_items
      WHERE calibration_id IN (${placeholders})
      ORDER BY id ASC
    `).all(...calibrationIds);

    lineItems.forEach((item) => {
      if (!itemsByCalibration[item.calibration_id]) itemsByCalibration[item.calibration_id] = [];
      itemsByCalibration[item.calibration_id].push(item);
    });
  }

  const history = calibrations.map((c) => {
    const items = itemsByCalibration[c.id] || [];
    return {
      ...c,
      services: items.filter((i) => i.item_type === 'service'),
      spareParts: items.filter((i) => i.item_type === 'spare_part'),
      repairItems: items.filter((i) => i.item_type === 'repair'),
      total: items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0),
    };
  });

  const doneCount = history.filter((c) => c.done === 'Yes').length;
  const repairCount = history.filter((c) => c.repair === 'Yes').length;

  res.render('public/equipment', {
    equipment,
    history,
    doneCount,
    repairCount,
    badge: calibrationBadge(equipment.next_calibration_date),
    daysLeft: daysUntil(equipment.next_calibration_date),
    scannedAt: new Date().toISOString().split('T')[0],
  });
});

module.exports = router;