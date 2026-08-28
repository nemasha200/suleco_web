const db = require('../db');
const { addSixMonths } = require('./dates');

// Recomputes an equipment's last_calibration_date / next_calibration_date /
// status from the TRUE most recent "Done" calibration record on file —
// never from just whichever record happened to be added or edited most
// recently. This means editing an OLD historical calibration record (e.g.
// fixing a typo in a service from last year) can never accidentally push
// the equipment's real "next due" date backward or forward incorrectly.
//
// Call this after ANY insert, edit, or delete of a calibration record.
function syncEquipmentCalibrationDates(equipmentId) {
  const latest = db.prepare(`
    SELECT done_date, status FROM calibrations
    WHERE equipment_id = ? AND done = 'Yes' AND done_date IS NOT NULL AND done_date != ''
    ORDER BY done_date DESC
    LIMIT 1
  `).get(equipmentId);

  if (!latest) {
    // No completed calibration on file for this equipment (e.g. the only
    // Done record was just deleted) — clear the dates rather than leaving
    // a stale value that no longer corresponds to any real record.
    db.prepare(`
      UPDATE equipment SET last_calibration_date = NULL, next_calibration_date = NULL, status = 'Pending'
      WHERE id = ?
    `).run(equipmentId);
    return;
  }

  const next_calibration_date = addSixMonths(latest.done_date);
  db.prepare(`
    UPDATE equipment
    SET last_calibration_date = ?, next_calibration_date = ?, status = ?
    WHERE id = ?
  `).run(latest.done_date, next_calibration_date, latest.status || 'Completed', equipmentId);
}

module.exports = { syncEquipmentCalibrationDates };