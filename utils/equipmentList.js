// ---------------------------------------------------------------------------
// One source of truth for "every piece of equipment, with its badge and its
// lifetime billed total".
//
// The dashboard needs these rows to count overdue / due-soon / total, and the
// Add Equipment page needs the same rows to draw the table. Keeping the query
// here means the two pages can never drift apart — a change to how the total
// is calculated shows up in both places at once.
// ---------------------------------------------------------------------------
const db = require('../db');
const { calibrationBadge, daysUntil } = require('./dates');
const { calcTotals } = require('./money');

// Final billed total per equipment, matching what the service page shows:
// each calibration's line items, less its discount, plus SSCL and VAT. The
// arithmetic has to happen PER CALIBRATION because the discount is per job —
// summing every line item first and taxing once would give a different number.
const listBills = db.prepare(`
  SELECT calibrations.equipment_id AS equipment_id,
         COALESCE(calibrations.discount, 0) AS discount,
         COALESCE((
           SELECT SUM(li.amount) FROM calibration_line_items li
           WHERE li.calibration_id = calibrations.id
         ), 0) AS subtotal
  FROM calibrations
`);

function finalTotalsByEquipment() {
  const totals = {};
  listBills.all().forEach((row) => {
    const { total } = calcTotals(row.subtotal, row.discount);
    totals[row.equipment_id] = (totals[row.equipment_id] || 0) + total;
  });
  return totals;
}

// Every equipment row joined to its customer, soonest due first, with the
// badge and billed total already worked out.
function listEquipmentWithBadges() {
  const rows = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.phone AS customer_phone
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY next_calibration_date ASC
  `).all();

  const billed = finalTotalsByEquipment();

  return rows.map(r => ({
    ...r,
    total_amount: billed[r.id] || 0,
    badge: calibrationBadge(r.next_calibration_date),
    daysLeft: daysUntil(r.next_calibration_date),
  }));
}

// Overdue / due-within-7-days / total, from an already-built list.
function equipmentCounts(list) {
  return {
    overdueCount: list.filter(r => r.daysLeft !== null && r.daysLeft < 0).length,
    dueSoonCount: list.filter(r => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 7).length,
    totalCount: list.length,
  };
}

module.exports = { listEquipmentWithBadges, finalTotalsByEquipment, equipmentCounts };
