// ---------------------------------------------------------------------------
// Everything the dashboard panels need, in one place.
//
// Each exported function answers one panel's question and returns plain data —
// no HTML, no formatting decisions. The view does the drawing.
//
// A note on dates: the app stores them as 'YYYY-MM-DD' (and 'YYYY-MM-DD HH:MM:SS'
// for created_at), so string comparison and SQL's strftime both work directly.
// No timezone conversion happens here; the server's own clock is the reference,
// same as everywhere else in the app.
// ---------------------------------------------------------------------------
const db = require('../db');
const { calcTotals } = require('./money');

const today = () => new Date().toISOString().split('T')[0];

// Databases created by older versions of this app are missing some of the
// newer columns. Checking rather than assuming means the dashboard degrades to
// "that panel shows less" instead of a 500 page.
function hasColumn(table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  } catch {
    return false;
  }
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The three business divisions, plus a bucket for equipment that predates the
// category field (company_category is NULL on those rows).
const DIVISIONS = ['Survey', 'Lab', 'Drones'];

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

// Each calibration's final billed figure, tagged with the month it belongs to.
// A job counts in the month it was DONE; if it has no done date yet it falls
// back to the month it was created, so work in progress still shows up.
const listBilledJobs = db.prepare(`
  SELECT calibrations.id,
         COALESCE(NULLIF(calibrations.done_date, ''), date(calibrations.created_at)) AS bill_date,
         COALESCE(calibrations.discount, 0) AS discount,
         COALESCE((
           SELECT SUM(li.amount) FROM calibration_line_items li
           WHERE li.calibration_id = calibrations.id
         ), 0) AS subtotal
  FROM calibrations
  JOIN equipment ON equipment.id = calibrations.equipment_id
  WHERE (? IS NULL OR equipment.company_category = ?)
`);

// Every division-aware function takes the same optional argument: a division
// name, or null for "all departments". Passing it straight into the query as a
// pair of bound values keeps one statement doing both jobs — no string
// concatenation, so nothing can be injected through the query string.
function onlyDivision(division) {
  return DIVISIONS.includes(division) ? division : null;
}

// Rupee income per month, newest last, for the last `months` months including
// this one. Returns [{ key: '2026-04', label: 'Apr', value: 125000 }, …].
function incomeByMonth(months = 6, division = null) {
  const only = onlyDivision(division);
  const now = new Date();
  const buckets = [];
  const index = {};

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket = { key, label: MONTH_NAMES[d.getMonth()], value: 0 };
    buckets.push(bucket);
    index[key] = bucket;
  }

  listBilledJobs.all(only, only).forEach((job) => {
    if (!job.bill_date) return;
    const key = job.bill_date.slice(0, 7);
    if (!index[key]) return;               // outside the window we're showing
    index[key].value += calcTotals(job.subtotal, job.discount).total;
  });

  return buckets;
}

// This month's income, how it compares with last month, and the job counts
// that sit beside it in the panel.
function incomeSummary(months = 6, division = null) {
  const only = onlyDivision(division);
  const series = incomeByMonth(months, only);
  const thisMonth = series[series.length - 1] ? series[series.length - 1].value : 0;
  const lastMonth = series[series.length - 2] ? series[series.length - 2].value : 0;

  // No previous month to compare against (or it was zero) means a percentage
  // would be meaningless or infinite — say nothing rather than print "∞%".
  const changePct = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;

  const counts = db.prepare(`
    SELECT COUNT(*) AS all_jobs,
           SUM(CASE WHEN calibrations.done = 'Yes' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN calibrations.done != 'Yes' OR calibrations.done IS NULL THEN 1 ELSE 0 END) AS pending
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    WHERE (? IS NULL OR equipment.company_category = ?)
  `).get(only, only);

  return {
    series,
    thisMonth,
    lastMonth,
    changePct,
    allJobs: counts.all_jobs || 0,
    completed: counts.completed || 0,
    pending: counts.pending || 0,
  };
}

// ---------------------------------------------------------------------------
// Tracking + forecast
// ---------------------------------------------------------------------------

// Due-date counts per day for the next 7 days, starting today. This is the
// real "forecast": how much work is landing this week.
function dueForecast(days = 7, division = null) {
  const only = onlyDivision(division);
  const rows = db.prepare(`
    SELECT next_calibration_date AS due, COUNT(*) AS count
    FROM equipment
    WHERE next_calibration_date IS NOT NULL AND next_calibration_date != ''
      AND (? IS NULL OR company_category = ?)
    GROUP BY next_calibration_date
  `).all(only, only);

  const byDate = {};
  rows.forEach(r => { byDate[r.due] = r.count; });

  const out = [];
  const start = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = d.toISOString().split('T')[0];
    out.push({
      date: key,
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
      count: byDate[key] || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

// Equipment split by division — the donut. Anything without a category (older
// rows created before the field existed) lands in "Others".
function equipmentByDivision() {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(company_category, ''), 'Others') AS division, COUNT(*) AS count
    FROM equipment
    GROUP BY division
  `).all();

  const byName = {};
  rows.forEach(r => { byName[r.division] = r.count; });

  const slices = DIVISIONS.map(name => ({ name, count: byName[name] || 0 }));

  // Everything that isn't one of the three known divisions gets folded into a
  // single "Others" slice, so an unexpected value can never go missing.
  const others = rows
    .filter(r => !DIVISIONS.includes(r.division))
    .reduce((sum, r) => sum + r.count, 0);
  if (others > 0) slices.push({ name: 'Others', count: others });

  const total = slices.reduce((sum, s) => sum + s.count, 0);
  return { slices, total };
}

// How much of each division's equipment is currently IN DATE — i.e. its next
// calibration is still in the future. This is the honest version of an
// "achievement" figure: it is measured, not targeted.
function divisionCompletion() {
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(company_category, ''), 'Others') AS division,
           COUNT(*) AS total,
           SUM(CASE WHEN next_calibration_date >= ? THEN 1 ELSE 0 END) AS in_date
    FROM equipment
    GROUP BY division
  `).all(today());

  const byName = {};
  rows.forEach(r => { byName[r.division] = r; });

  return DIVISIONS.map((name) => {
    const row = byName[name] || { total: 0, in_date: 0 };
    const total = row.total || 0;
    const inDate = row.in_date || 0;
    return {
      name,
      total,
      inDate,
      percent: total > 0 ? Math.round((inDate / total) * 100) : 0,
    };
  });
}

// Completed jobs per month, per division — the grouped bars. Useful on its own
// and the natural place to hang real targets once you store them.
function jobsByMonthAndDivision(months = 6) {
  const now = new Date();
  const buckets = [];
  const index = {};

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const bucket = { key, label: MONTH_NAMES[d.getMonth()], done: 0, total: 0 };
    buckets.push(bucket);
    index[key] = bucket;
  }

  db.prepare(`
    SELECT COALESCE(NULLIF(calibrations.done_date, ''), date(calibrations.created_at)) AS bill_date,
           calibrations.done AS done
    FROM calibrations
  `).all().forEach((row) => {
    if (!row.bill_date) return;
    const bucket = index[row.bill_date.slice(0, 7)];
    if (!bucket) return;
    bucket.total += 1;
    if (row.done === 'Yes') bucket.done += 1;
  });

  return buckets;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

// Busiest customers by number of service jobs. "Active" means they have at
// least one piece of equipment still being tracked.
function topCustomers(limit = 5, division = null) {
  const only = onlyDivision(division);
  return db.prepare(`
    SELECT customers.id,
           customers.name,
           customers.company,
           COUNT(DISTINCT calibrations.id) AS service_count,
           COUNT(DISTINCT equipment.id) AS equipment_count
    FROM customers
    LEFT JOIN equipment ON equipment.customer_id = customers.id
                        AND (? IS NULL OR equipment.company_category = ?)
    LEFT JOIN calibrations ON calibrations.equipment_id = equipment.id
    GROUP BY customers.id
    HAVING (? IS NULL OR equipment_count > 0)
    ORDER BY service_count DESC, equipment_count DESC, customers.name ASC
    LIMIT ?
  `).all(only, only, only, limit).map(c => ({ ...c, active: c.equipment_count > 0 }));
}

// ---------------------------------------------------------------------------
// Activity feeds
// ---------------------------------------------------------------------------

function relativeTime(sqlDateTime) {
  if (!sqlDateTime) return '';
  const when = new Date(sqlDateTime.replace(' ', 'T'));
  if (isNaN(when)) return sqlDateTime;

  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return when.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function clockTime(sqlDateTime) {
  if (!sqlDateTime) return '';
  const when = new Date(sqlDateTime.replace(' ', 'T'));
  if (isNaN(when)) return '';
  return when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// The notifications panel: things that need the admin's attention, newest
// first. Overdue equipment is the loudest signal, so it leads; recent reminder
// activity and new registrations fill the rest.
function notificationFeed(limit = 4, division = null) {
  const only = onlyDivision(division);
  const items = [];

  db.prepare(`
    SELECT equipment.serial_number, equipment.next_calibration_date, customers.name AS customer_name
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    WHERE equipment.next_calibration_date IS NOT NULL
      AND equipment.next_calibration_date != ''
      AND equipment.next_calibration_date < ?
      AND (? IS NULL OR equipment.company_category = ?)
    ORDER BY equipment.next_calibration_date ASC
    LIMIT 3
  `).all(today(), only, only).forEach((r) => {
    items.push({
      tone: 'red',
      text: `${r.serial_number || 'Equipment'} for ${r.customer_name} is overdue`,
      meta: `was due ${r.next_calibration_date}`,
      href: '/equipment/new',
    });
  });

  db.prepare(`
    SELECT notification_log.customer_name, notification_log.channel,
           notification_log.status, notification_log.sent_at
    FROM notification_log
    ORDER BY notification_log.sent_at DESC
    LIMIT 3
  `).all().forEach((r) => {
    items.push({
      tone: r.status === 'failed' ? 'red' : 'green',
      text: `Reminder ${r.status} by ${r.channel} — ${r.customer_name || 'customer'}`,
      meta: relativeTime(r.sent_at),
      href: '/notifications',
    });
  });

  (hasColumn('customers', 'created_at')
    ? db.prepare('SELECT name, company, created_at FROM customers ORDER BY id DESC LIMIT 2').all()
    : db.prepare('SELECT name, company, NULL AS created_at FROM customers ORDER BY id DESC LIMIT 2').all()
  ).forEach((r) => {
    items.push({
      tone: 'blue',
      text: `New customer registered — ${r.company || r.name}`,
      meta: relativeTime(r.created_at),
      href: '/customers',
    });
  });

  return items.slice(0, limit);
}

// The activity strip: a plain log of what happened, most recent first, mixing
// service jobs and new equipment.
function recentActivity(limit = 5, division = null) {
  const only = onlyDivision(division);
  const jobs = db.prepare(`
    SELECT calibrations.id, calibrations.description, calibrations.done,
           calibrations.created_at AS at,
           equipment.serial_number, equipment.equipment_type
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    WHERE (? IS NULL OR equipment.company_category = ?)
    ORDER BY calibrations.id DESC LIMIT ?
  `).all(only, only, limit).map(r => ({
    at: r.at,
    tone: r.done === 'Yes' ? 'green' : 'blue',
    text: r.done === 'Yes'
      ? `${r.description || 'Service'} completed — ${r.serial_number || r.equipment_type || ''}`.trim()
      : `${r.description || 'Service'} in progress — ${r.serial_number || r.equipment_type || ''}`.trim(),
  }));

  // equipment.created_at only exists on databases created by newer versions,
  // so rows registered before it was added simply don't appear in this feed.
  const kit = hasColumn('equipment', 'created_at')
    ? db.prepare(`
        SELECT equipment.created_at AS at, equipment.serial_number, equipment.equipment_type,
               customers.name AS customer_name
        FROM equipment
        JOIN customers ON customers.id = equipment.customer_id
        WHERE equipment.created_at IS NOT NULL AND equipment.created_at != ''
          AND (? IS NULL OR equipment.company_category = ?)
        ORDER BY equipment.id DESC LIMIT ?
      `).all(only, only, limit).map(r => ({
        at: r.at,
        tone: 'amber',
        text: `${r.equipment_type || 'Equipment'} registered for ${r.customer_name}`,
      }))
    : [];

  return [...jobs, ...kit]
    .filter(r => r.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit)
    .map(r => ({ ...r, time: clockTime(r.at), ago: relativeTime(r.at) }));
}

module.exports = {
  onlyDivision,
  incomeByMonth,
  incomeSummary,
  dueForecast,
  equipmentByDivision,
  divisionCompletion,
  jobsByMonthAndDivision,
  topCustomers,
  notificationFeed,
  recentActivity,
  relativeTime,
  DIVISIONS,
};
