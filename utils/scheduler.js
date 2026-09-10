const cron = require('node-cron');
const db = require('../db');
const { daysUntil } = require('./dates');
const { sendEmail, sendSMS, buildEmailMessage, buildSmsMessage } = require('./notify');

// ---------------------------------------------------------------------------
// Configuration (all overridable from .env)
// ---------------------------------------------------------------------------

// How many days before the due date to send the reminder.
const REMIND_DAYS_BEFORE = Number(process.env.REMIND_DAYS_BEFORE) || 7;

// What time of day the automatic sweep should run, as HH:MM (24-hour).
const DAILY_RUN_TIME = process.env.DAILY_RUN_TIME || '09:00';

// Timezone the above time is interpreted in. Pinning this means the job fires
// at 9 AM Sri Lankan time even if the machine's clock/locale is set to
// something else.
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

const [RUN_HOUR, RUN_MINUTE] = DAILY_RUN_TIME.split(':').map(Number);
const RUN_MINUTE_OF_DAY = RUN_HOUR * 60 + RUN_MINUTE;

// How often to re-check that today's run actually happened. This is the
// safety net for the case cron alone cannot handle: the PC being off, asleep,
// or the app not started at 9 AM.
const CATCHUP_CHECK_MINUTES = 15;

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const logNotification = db.prepare(`
  INSERT INTO notification_log (equipment_id, customer_name, channel, target, status, detail)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const markReminded = db.prepare(`
  UPDATE equipment SET last_notified_date = ?, reminded_for_due_date = ? WHERE id = ?
`);

const insertRun = db.prepare(`
  INSERT INTO notification_runs (run_date, trigger_type, started_at)
  VALUES (?, ?, datetime('now', 'localtime'))
`);

const finishRun = db.prepare(`
  UPDATE notification_runs
  SET finished_at = datetime('now', 'localtime'),
      checked = ?, notified = ?,
      email_sent = ?, email_failed = ?,
      sms_sent = ?, sms_failed = ?,
      recipients = ?, error = ?
  WHERE id = ?
`);

const countAutoRunsOn = db.prepare(`
  SELECT COUNT(*) AS c FROM notification_runs
  WHERE run_date = ? AND trigger_type IN ('scheduled', 'catchup') AND finished_at IS NOT NULL
`);

// Equipment that is inside the reminder window and has NOT yet been reminded
// for its current due date. Used by the top-up check below to notice records
// added or edited after today's sweep already ran.
const listPendingReminderIds = db.prepare(`
  SELECT id FROM equipment
  WHERE next_calibration_date IS NOT NULL
    AND (reminded_for_due_date IS NULL OR reminded_for_due_date != next_calibration_date)
    AND julianday(next_calibration_date) - julianday('now', 'localtime', 'start of day') <= ?
`);

// ---------------------------------------------------------------------------
// Which items we have already tried today
// ---------------------------------------------------------------------------
// A reminder whose email keeps failing stays "pending" forever. Without this
// memory, the top-up check would see it every 15 minutes and fire an endless
// stream of sweeps. So we remember which equipment ids have already been
// attempted today: a failing item is retried on the next DAILY run, while a
// genuinely new record still triggers a top-up within minutes. The memory
// resets when the date rolls over.
let attemptedOn = null;
let attemptedIds = new Set();

function resetAttemptedIfNewDay(date) {
  if (attemptedOn !== date) {
    attemptedOn = date;
    attemptedIds = new Set();
  }
}

function rememberAttempted(date, ids) {
  resetAttemptedIfNewDay(date);
  ids.forEach(id => attemptedIds.add(id));
}

// ---------------------------------------------------------------------------
// Timezone-aware "what day and time is it right now" helper
// ---------------------------------------------------------------------------

function nowInZone() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    clock: `${parts.hour}:${parts.minute}`,
  };
}

// ---------------------------------------------------------------------------
// The sweep itself
// ---------------------------------------------------------------------------

// Guards against two sweeps running at once (e.g. the cron tick landing at the
// same moment as the catch-up check, or an admin clicking the button mid-run).
let sweepInProgress = false;

async function runNotificationSweep(options = {}) {
  const trigger = options.trigger || 'manual';

  if (sweepInProgress) {
    console.log(`Sweep requested (${trigger}) but one is already running — skipping this one.`);
    return { skipped: true, reason: 'A reminder sweep is already in progress.', checked: 0, notified: 0 };
  }
  sweepInProgress = true;

  const { date: runDate, clock } = nowInZone();
  const runId = insertRun.run(runDate, trigger).lastInsertRowid;

  const counts = { checked: 0, notified: 0, emailSent: 0, emailFailed: 0, smsSent: 0, smsFailed: 0 };
  const recipients = [];
  const attemptedNow = [];
  let fatalError = null;

  try {
    const rows = db.prepare(`
      SELECT equipment.*, customers.name AS customer_name,
             customers.phone AS customer_phone, customers.email AS customer_email
      FROM equipment
      JOIN customers ON customers.id = equipment.customer_id
    `).all();

    counts.checked = rows.length;
    const today = new Date().toISOString().split('T')[0];

    for (const row of rows) {
      const daysLeft = daysUntil(row.next_calibration_date);
      if (daysLeft === null) continue; // no due date set, nothing to notify about

      // Fire once per due date: the first sweep that sees this item at
      // REMIND_DAYS_BEFORE-or-fewer days left (and hasn't already reminded for
      // THIS SPECIFIC due date) sends the single reminder. If the due date
      // later changes (calibration gets done, new date set),
      // reminded_for_due_date no longer matches, so a fresh reminder fires.
      const isWithinReminderWindow = daysLeft <= REMIND_DAYS_BEFORE;
      const alreadyRemindedForThisDueDate = row.reminded_for_due_date === row.next_calibration_date;

      if (!isWithinReminderWindow || alreadyRemindedForThisDueDate) continue;

      // Note that we have now had a go at this one today, whatever the outcome.
      attemptedNow.push(row.id);

      // Email and SMS are composed independently — see the note in notify.js.
      const { subject, text, html } = buildEmailMessage({ ...row, daysLeft });
      const smsText = buildSmsMessage({ ...row, daysLeft });

      const emailResult = await sendEmail(row.customer_email, subject, text, html);
      logNotification.run(row.id, row.customer_name, 'email', row.customer_email || '', emailResult.status, emailResult.detail);

      const smsResult = await sendSMS(row.customer_phone, smsText);
      logNotification.run(row.id, row.customer_name, 'sms', row.customer_phone || '', smsResult.status, smsResult.detail);

      const emailSucceeded = emailResult.status.startsWith('sent');
      const smsSucceeded = smsResult.status.startsWith('sent');

      if (emailSucceeded) counts.emailSent++; else if (emailResult.status === 'failed') counts.emailFailed++;
      if (smsSucceeded) counts.smsSent++; else if (smsResult.status === 'failed') counts.smsFailed++;

      recipients.push({
        customerId: row.customer_id,
        customer: row.customer_name,
        equipment: `${row.brand || ''} ${row.equipment_type || ''}`.trim() || 'Equipment',
        serial: row.serial_number || '',
        due: row.next_calibration_date,
        daysLeft,
        email: { target: row.customer_email || '', status: emailResult.status },
        sms: { target: row.customer_phone || '', status: smsResult.status },
      });

      // Only mark this due date as "reminded" if the email actually went out.
      // If it failed, leave it unmarked so the next sweep retries automatically
      // instead of silently giving up forever. SMS success/failure doesn't
      // block this — SMS retries independently.
      if (emailSucceeded) {
        markReminded.run(today, row.next_calibration_date, row.id);
        counts.notified++;
      } else {
        console.warn(`Email reminder FAILED for ${row.customer_name} (equipment #${row.id}) — will retry on the next sweep. Detail: ${emailResult.detail}`);
      }

      console.log(`Reminded ${row.customer_name} about ${row.brand} ${row.equipment_type} (due ${row.next_calibration_date}) — email: ${emailResult.status}, sms: ${smsResult.status}`);
    }
  } catch (err) {
    fatalError = err.message;
    console.error('Notification sweep failed:', err);
  } finally {
    finishRun.run(
      counts.checked, counts.notified,
      counts.emailSent, counts.emailFailed,
      counts.smsSent, counts.smsFailed,
      JSON.stringify(recipients),
      fatalError,
      runId
    );
    rememberAttempted(runDate, attemptedNow);
    sweepInProgress = false;
  }

  console.log(`[${trigger}] sweep finished at ${clock} ${TIMEZONE} — checked ${counts.checked}, reminders sent for ${counts.notified}.`);

  return { runId, trigger, runDate, ...counts, recipients, error: fatalError };
}

// ---------------------------------------------------------------------------
// Catch-up: the part that makes this genuinely reliable
// ---------------------------------------------------------------------------

// node-cron only fires if the process is alive at the exact moment. On an
// office PC that gets switched off overnight, or sleeps, or where the app is
// started at 10 AM, the 9 AM tick simply never happens and that day is
// silently skipped forever. So: any time we notice that today's automatic run
// hasn't happened yet AND the scheduled time has already passed, we run it.
async function runCatchUpIfMissed(reason) {
  const { date, minuteOfDay, clock } = nowInZone();

  if (minuteOfDay < RUN_MINUTE_OF_DAY) return; // not yet time today
  if (countAutoRunsOn.get(date).c > 0) return; // already ran today

  console.log(`Today's ${DAILY_RUN_TIME} reminder run had not happened yet (noticed at ${clock}, ${reason}) — running it now.`);
  await runNotificationSweep({ trigger: 'catchup' });
}

// ---------------------------------------------------------------------------
// Top-up: pick up equipment added or edited AFTER today's sweep already ran
// ---------------------------------------------------------------------------
// The daily sweep is a snapshot. Add a machine at 2 PM whose calibration is due
// today and nothing looks at it until 9 AM tomorrow, because runCatchUpIfMissed
// sees a completed run for today and stops. This check closes that gap: if any
// item is inside the reminder window and has not been attempted yet today, run
// one more sweep. Duplicates are impossible — reminded_for_due_date still
// guards every individual send.
async function runTopUpIfPending() {
  const { date, minuteOfDay, clock } = nowInZone();

  if (minuteOfDay < RUN_MINUTE_OF_DAY) return; // before the daily slot, leave it alone
  resetAttemptedIfNewDay(date);

  const pending = listPendingReminderIds.all(REMIND_DAYS_BEFORE).map(r => r.id);
  const fresh = pending.filter(id => !attemptedIds.has(id));
  if (fresh.length === 0) return;

  console.log(`${fresh.length} item(s) entered the reminder window since the last sweep (noticed at ${clock}) — running a top-up sweep.`);
  await runNotificationSweep({ trigger: 'catchup' });
}

function startScheduler() {
  // 1. The normal daily job, pinned to the configured timezone.
  cron.schedule(`${RUN_MINUTE} ${RUN_HOUR} * * *`, () => {
    console.log(`Running scheduled ${DAILY_RUN_TIME} calibration notification sweep...`);
    runNotificationSweep({ trigger: 'scheduled' })
      .catch(err => console.error('Scheduled sweep failed:', err));
  }, { timezone: TIMEZONE });

  // 2. Catch-up on startup, a few seconds after boot so the server is fully up.
  setTimeout(() => {
    runCatchUpIfMissed('app startup')
      .then(() => runTopUpIfPending())
      .catch(err => console.error('Startup catch-up failed:', err));
  }, 5000);

  // 3. Rolling safety net, for sleep/hibernate and long-running sessions.
  setInterval(() => {
    runCatchUpIfMissed('periodic check')
      .then(() => runTopUpIfPending())
      .catch(err => console.error('Catch-up check failed:', err));
  }, CATCHUP_CHECK_MINUTES * 60 * 1000);

  console.log(`Notification scheduler started — daily at ${DAILY_RUN_TIME} (${TIMEZONE}), reminding ${REMIND_DAYS_BEFORE} days before due date, once per due date.`);
  console.log(`Missed-run catch-up and new-record top-up are active (checked at startup and every ${CATCHUP_CHECK_MINUTES} minutes).`);
}

module.exports = { startScheduler, runNotificationSweep, runCatchUpIfMissed, runTopUpIfPending, DAILY_RUN_TIME, TIMEZONE };