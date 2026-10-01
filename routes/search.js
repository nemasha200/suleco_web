const express = require('express');
const router = express.Router();
const db = require('../db');
const { calibrationBadge } = require('../utils/dates');

// ---------------------------------------------------------------------------
// Serial number search
//
// This box searches serial numbers and nothing else. An unambiguous match
// jumps straight to the step that needs doing:
//
//   EXACT serial -> job checked in, not finished -> that job's workflow page
//   EXACT serial -> equipment, no open job       -> Check In, serial selected
//   anything else                                -> the results page
//
// Everything here is exact-match. A serial identifies one instrument, so a
// near-miss is not a result: typing 111 used to match 11112222 and open the
// wrong machine's job. If the serial is not on file you get the register-it
// card instead, which is the truthful answer.
//
// Customers are found through the Customers page, not here — searching a
// company name used to navigate somewhere unexpected, which made the box
// unpredictable.
// ---------------------------------------------------------------------------

// Only an exact serial opens a record directly.
const equipmentByExactSerial = db.prepare(`
  SELECT id FROM equipment WHERE serial_number = ? COLLATE NOCASE
`);


// A job that has been checked in but not finished.
const openJobForEquipment = db.prepare(`
  SELECT id FROM calibrations
  WHERE equipment_id = ? AND stage IN ('approval', 'service')
  ORDER BY id DESC LIMIT 1
`);

function findSingleEquipment(q) {
  // Exact, and exactly one of them. Two instruments sharing a serial is a data
  // problem, not something to guess our way through.
  const exact = equipmentByExactSerial.all(q);
  return exact.length === 1 ? exact[0] : null;
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();

  // ---- Jump straight to the right step where the serial is unambiguous ----
  if (q) {
    const equipment = findSingleEquipment(q);

    if (equipment) {
      const openJob = openJobForEquipment.get(equipment.id);

      // Mid-flight job: drop the user on Approval or Service, whichever it's at.
      if (openJob) return res.redirect(`/calibrations/${openJob.id}/workflow`);

      // Registered but no open job — start one, serial already selected.
      return res.redirect(`/calibrations/new?equipment_id=${equipment.id}`);
    }
  }

  // ---- Otherwise: the results page ----
  let results = [];

  if (q) {
    // Exact serial only — no LIKE. Searching 111 must not return 11112222:
    // a serial identifies one physical instrument, and showing near-misses
    // invites opening the wrong machine's record.
    //
    // (To list partial matches again, change the WHERE clause to
    //  `equipment.serial_number LIKE ?` and pass `%${q}%`.)
    const equipment = db.prepare(`
      SELECT equipment.*, customers.name AS customer_name,
             customers.phone AS customer_phone, customers.email AS customer_email
      FROM equipment
      JOIN customers ON customers.id = equipment.customer_id
      WHERE equipment.serial_number = ? COLLATE NOCASE
      ORDER BY equipment.serial_number ASC
    `).all(q);

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

    results = equipment.map((e) => {
      // So each result can offer the RIGHT next step: continue the job that is
      // already running, or start a new check-in with this serial selected.
      const openJob = openJobForEquipment.get(e.id);
      return {
        ...e,
        openJobId: openJob ? openJob.id : null,
        badge: calibrationBadge(e.next_calibration_date),
        calibrations: calibrationsByEquipment[e.id] || [],
      };
    });
  }

  res.render('search', {
    q,
    results,
    username: req.session.username,
  });
});

module.exports = router;
