const express = require('express');
const router = express.Router();
const db = require('../db');
const { calibrationBadge } = require('../utils/dates');

// Search equipment by serial number (also matches customer name / brand / type
// so a broader typo-tolerant search still finds something useful), then pull
// in that equipment's calibration history so everything needed shows in one place.
router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();

  let results = [];

  if (q) {
    const like = `%${q}%`;
    const equipment = db.prepare(`
      SELECT equipment.*, customers.name AS customer_name,
             customers.phone AS customer_phone, customers.email AS customer_email
      FROM equipment
      JOIN customers ON customers.id = equipment.customer_id
      WHERE equipment.serial_number LIKE ?
         OR customers.name LIKE ?
         OR equipment.brand LIKE ?
         OR equipment.equipment_type LIKE ?
      ORDER BY equipment.serial_number ASC
    `).all(like, like, like, like);

    const equipmentIds = equipment.map((e) => e.id);
    let calibrationsByEquipment = {};

    if (equipmentIds.length > 0) {
      const placeholders = equipmentIds.map(() => '?').join(',');
      const calRows = db.prepare(`
        SELECT * FROM calibrations
        WHERE equipment_id IN (${placeholders})
        ORDER BY id DESC
      `).all(...equipmentIds);

      calRows.forEach((c) => {
        if (!calibrationsByEquipment[c.equipment_id]) calibrationsByEquipment[c.equipment_id] = [];
        calibrationsByEquipment[c.equipment_id].push(c);
      });
    }

    results = equipment.map((e) => ({
      ...e,
      badge: calibrationBadge(e.next_calibration_date),
      calibrations: calibrationsByEquipment[e.id] || [],
    }));
  }

  res.render('search', {
    q,
    results,
    username: req.session.username,
  });
});

module.exports = router;