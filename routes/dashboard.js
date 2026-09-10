const express = require('express');
const router = express.Router();
const db = require('../db');
const { calibrationBadge, daysUntil } = require('../utils/dates');
const { runNotificationSweep, DAILY_RUN_TIME, TIMEZONE } = require('../utils/scheduler');
const { sendEmail, sendSMS, buildEmailMessage, buildSmsMessage } = require('../utils/notify');

// The newest automatic (scheduled/catch-up) run the admin hasn't acknowledged
// yet. This is what powers the "reminders were sent automatically" popup.
const findUnseenAutoRun = db.prepare(`
  SELECT * FROM notification_runs
  WHERE trigger_type IN ('scheduled', 'catchup')
    AND finished_at IS NOT NULL
    AND seen = 0
  ORDER BY id DESC LIMIT 1
`);

const markRunSeen = db.prepare('UPDATE notification_runs SET seen = 1 WHERE id = ?');

// Everything older than the one we're about to show gets marked seen too, so a
// week away from the office doesn't produce a queue of stale popups.
const markAllAutoRunsSeen = db.prepare(`
  UPDATE notification_runs SET seen = 1 WHERE trigger_type IN ('scheduled', 'catchup')
`);

// The recipients JSON is a frozen snapshot taken at send time, so a customer
// renamed afterwards would keep showing the old name forever. Newer rows store
// customerId, which lets us show the CURRENT name while keeping the name the
// message actually went out under (audit trail).
const lookupCustomerName = db.prepare('SELECT name FROM customers WHERE id = ?');

function parseRecipients(json) {
  let list;
  try {
    list = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  return list.map(r => {
    const sentAs = r.customer || '';
    let current = sentAs;
    if (r.customerId) {
      const row = lookupCustomerName.get(r.customerId);
      if (row && row.name) current = row.name;
    }
    return { ...r, customer: current, sentAs, renamed: !!sentAs && current !== sentAs };
  });
}

// Same idea for the per-message log: customer_name in notification_log is also
// a frozen copy, so resolve the live name through equipment -> customers.
const listNotificationLogs = db.prepare(`
  SELECT notification_log.*,
         COALESCE(customers.name, notification_log.customer_name) AS current_customer_name
  FROM notification_log
  LEFT JOIN equipment ON equipment.id = notification_log.equipment_id
  LEFT JOIN customers ON customers.id = equipment.customer_id
  ORDER BY notification_log.sent_at DESC
  LIMIT 200
`);

// ---------------------------------------------------------------------------
// Turn the raw run record into something a person can read at a glance.
// "Last automatic run: 2026-09-07 11:16:31 — 0 reminder(s) sent catch-up" is
// accurate but reads like a log line. What the admin actually wants to know is:
// is this working, when did it last happen, what did it do, and when is next.
// ---------------------------------------------------------------------------

function friendlyDateTime(sqlDateTime) {
  if (!sqlDateTime) return null;
  // Stored as 'YYYY-MM-DD HH:MM:SS' in server local time.
  const when = new Date(sqlDateTime.replace(' ', 'T'));
  if (isNaN(when)) return sqlDateTime;

  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayGap = Math.round((startOfDay(new Date()) - startOfDay(when)) / 86400000);

  if (dayGap === 0) return `today at ${time}`;
  if (dayGap === 1) return `yesterday at ${time}`;
  if (dayGap < 7) return `${when.toLocaleDateString('en-US', { weekday: 'long' })} at ${time}`;
  return `${when.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })} at ${time}`;
}

function buildAutomationStatus(lastRun, dailyRunTime, overdueCount, timezone) {
  const [hour, minute] = dailyRunTime.split(':').map(Number);
  const runTimeLabel = new Date(2000, 0, 1, hour, minute)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Read the clock in the SAME timezone the scheduler fires in, not the
  // server's locale. Otherwise a machine set to a different zone would say
  // "next check today" when today's run has already been and gone.
  const nowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const nowMinutes = Number(nowParts.find(p => p.type === 'hour').value) * 60
                   + Number(nowParts.find(p => p.type === 'minute').value);

  const beforeTodaysRun = nowMinutes < hour * 60 + minute;
  const nextRun = `${beforeTodaysRun ? 'today' : 'tomorrow'} at ${runTimeLabel}`;

  if (!lastRun) {
    return {
      tone: 'pending',
      headline: 'Automatic reminders are switched on',
      detail: `The first run happens ${nextRun}. Nothing has been sent yet.`,
      nextRun,
      runTimeLabel,
    };
  }

  if (lastRun.error) {
    return {
      tone: 'error',
      headline: 'The last automatic run hit a problem',
      detail: `It ran ${friendlyDateTime(lastRun.finished_at)} but did not finish cleanly. The next attempt is ${nextRun}.`,
      nextRun,
      runTimeLabel,
    };
  }

  const failures = (lastRun.email_failed || 0) + (lastRun.sms_failed || 0);
  const sent = lastRun.notified || 0;
  const when = friendlyDateTime(lastRun.finished_at);

  let detail;
  if (sent > 0) {
    detail = `Sent ${sent} reminder${sent === 1 ? '' : 's'} ${when}.`;
  } else if (overdueCount > 0) {
    // The confusing case: overdue items on screen, yet nothing sent. Explain it
    // rather than leaving the admin to wonder whether the job is broken.
    detail = `Ran ${when} — no new reminders were needed. Customers with overdue equipment have already been contacted, and are not messaged again unless their due date changes.`;
  } else {
    detail = `Ran ${when} — nothing was due, so no messages were sent.`;
  }

  if (failures > 0) {
    detail += ` ${failures} message${failures === 1 ? '' : 's'} failed to send and will be retried.`;
  }

  return {
    tone: failures > 0 ? 'warning' : 'ok',
    headline: failures > 0 ? 'Reminders ran, with some delivery failures' : 'Reminders are running automatically',
    detail,
    nextRun,
    runTimeLabel,
    wasCatchUp: lastRun.trigger_type === 'catchup',
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.phone AS customer_phone
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY next_calibration_date ASC
  `).all();

  const withBadges = rows.map(r => ({
    ...r,
    badge: calibrationBadge(r.next_calibration_date),
    daysLeft: daysUntil(r.next_calibration_date),
  }));

  const overdueCount = withBadges.filter(r => r.daysLeft !== null && r.daysLeft < 0).length;
  const dueSoonCount = withBadges.filter(r => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 7).length;
  const totalCount = withBadges.length;

  const flash = req.session.flash || null;
  delete req.session.flash;

  // Pick up the proof-of-send popup, then immediately mark it acknowledged so
  // it appears exactly once per automatic run. The permanent record stays on
  // the Notification Log page either way.
  const unseenRun = findUnseenAutoRun.get();
  let autoRun = null;
  if (unseenRun) {
    autoRun = { ...unseenRun, recipientList: parseRecipients(unseenRun.recipients) };
    markAllAutoRunsSeen.run();
    markRunSeen.run(unseenRun.id);
  }

  // Small status line so the admin can always see the automation is alive,
  // even on days when there was nothing due to send.
  const lastRun = db.prepare(`
    SELECT * FROM notification_runs
    WHERE trigger_type IN ('scheduled', 'catchup') AND finished_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get();

  res.render('dashboard', {
    equipment: withBadges,
    overdueCount,
    dueSoonCount,
    totalCount,
    username: req.session.username,
    flash,
    autoRun,
    lastRun,
    automation: buildAutomationStatus(lastRun, DAILY_RUN_TIME, overdueCount, TIMEZONE),
    dailyRunTime: DAILY_RUN_TIME,
    timezone: TIMEZONE,
  });
});

// Simple CSV export for reporting
router.get('/export.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT customers.name AS customer_name, customers.phone, customers.email,
           equipment.brand, equipment.equipment_type, equipment.serial_number,
           equipment.last_calibration_date, equipment.next_calibration_date, equipment.status
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY equipment.next_calibration_date ASC
  `).all();

  const header = 'Customer,Phone,Email,Brand,Equipment Type,Serial Number,Last Calibration,Next Calibration,Status\n';
  const csv = rows.map(r => [
    r.customer_name, r.phone, r.email, r.brand, r.equipment_type, r.serial_number,
    r.last_calibration_date, r.next_calibration_date, r.status
  ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="calibration_report.csv"');
  res.send(header + csv);
});

// Manually trigger the reminder sweep right now (button on the dashboard).
// Still here on purpose — useful for testing and for one-off sends. The
// automatic daily run does not depend on it.
router.post('/notify-now', async (req, res) => {
  try {
    const result = await runNotificationSweep({ trigger: 'manual' });
    if (result.skipped) {
      req.session.flash = result.reason;
    } else {
      req.session.flash = `Checked ${result.checked} item(s), sent reminders for ${result.notified}.`;
    }
  } catch (err) {
    console.error('Manual notify sweep failed:', err);
    req.session.flash = 'Notification sweep failed — check server logs.';
  }
  res.redirect('/');
});

// View a log of recently sent notifications, plus the automatic-run history
router.get('/notifications', (req, res) => {
  const logs = listNotificationLogs.all();

  const runs = db.prepare(`
    SELECT * FROM notification_runs ORDER BY id DESC LIMIT 60
  `).all().map(r => ({ ...r, recipientList: parseRecipients(r.recipients) }));

  res.render('notifications', {
    logs,
    runs,
    username: req.session.username,
    testResults: null,
    dailyRunTime: DAILY_RUN_TIME,
    timezone: TIMEZONE,
  });
});

// A stand-in equipment record used only by the test send below. It is shaped
// exactly like a row from the equipment/customers join, so the test message
// goes through the SAME templates a real reminder does. That is the point of
// the test: a one-line "this is a test" email proved SMTP worked but told you
// nothing about how the actual reminder looks in a client's inbox.
//
// `response_token` is deliberately omitted — a fake token would render a
// "View full service record" button that leads to a dead page.
function buildSampleRow() {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const lastDate = new Date(dueDate);
  lastDate.setFullYear(lastDate.getFullYear() - 1);
  const iso = (d) => d.toISOString().split('T')[0];

  return {
    customer_name: 'Sample Customer',
    equipment_type: 'Total Station',
    brand: 'Leica',
    model: 'TS07',
    serial_number: 'SAMPLE-0000',
    last_calibration_date: iso(lastDate),
    next_calibration_date: iso(dueDate),
    daysLeft: 7,
  };
}

// Send an on-demand test email/SMS to any address/number you type in.
// The body is the real reminder template so you can proof the wording and
// layout; only the subject is prefixed so a test can never be mistaken for a
// genuine customer reminder if it gets forwarded.
router.post('/notifications/test', async (req, res) => {
  const { test_email, test_phone } = req.body;
  const sample = buildSampleRow();

  const testResults = [];

  if (test_email && test_email.trim()) {
    const { subject, text, html } = buildEmailMessage(sample);
    const result = await sendEmail(test_email.trim(), `[TEST] ${subject}`, text, html);
    testResults.push({ channel: 'email', target: test_email.trim(), ...result });
  }
  if (test_phone && test_phone.trim()) {
    const smsText = `[TEST] ${buildSmsMessage(sample)}`;
    const result = await sendSMS(test_phone.trim(), smsText);
    testResults.push({ channel: 'sms', target: test_phone.trim(), ...result });
  }

  const logs = listNotificationLogs.all();

  const runs = db.prepare(`
    SELECT * FROM notification_runs ORDER BY id DESC LIMIT 60
  `).all().map(r => ({ ...r, recipientList: parseRecipients(r.recipients) }));

  res.render('notifications', {
    logs,
    runs,
    username: req.session.username,
    testResults,
    dailyRunTime: DAILY_RUN_TIME,
    timezone: TIMEZONE,
  });
});

module.exports = router;
