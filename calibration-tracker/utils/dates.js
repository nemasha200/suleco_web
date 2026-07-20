// Adds 6 months to a YYYY-MM-DD date string and returns YYYY-MM-DD
function addSixMonths(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + 6);
  return d.toISOString().split('T')[0];
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function calibrationBadge(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return { label: 'No date', className: 'badge-grey' };
  if (days < 0) return { label: `Overdue by ${Math.abs(days)}d`, className: 'badge-red' };
  if (days <= 14) return { label: `Due in ${days}d`, className: 'badge-amber' };
  return { label: `Due in ${days}d`, className: 'badge-green' };
}

module.exports = { addSixMonths, daysUntil, calibrationBadge };
