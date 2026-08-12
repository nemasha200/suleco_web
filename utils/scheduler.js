const cron = require('node-cron');
const db = require('../db');
const { daysUntil } = require('./dates');
const { sendEmail, sendSMS, buildMessage } = require('./notify');

// How many days before the due date to send the single reminder.
// Change REMIND_DAYS_BEFORE in .env to adjust (defaults to 7).
const REMIND_DAYS_BEFORE = Number(process.env.REMIND_DAYS_BEFORE) || 7;

const logNotification = db.prepare(`
  INSERT INTO notification_log (equipment_id, customer_name, channel, target, status, detail)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const markReminded = db.prepare(`
  UPDATE equipment SET last_notified_date = ?, reminded_for_due_date = ? WHERE id = ?
`);

async function runNotificationSweep() {
  const rows = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name,
           customers.phone AS customer_phone, customers.email AS customer_email
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
  `).all();

  const today = new Date().toISOString().split('T')[0];
  let notifiedCount = 0;

  for (const row of rows) {
    const daysLeft = daysUntil(row.next_calibration_date);
    if (daysLeft === null) continue; // no due date set, nothing to notify about

    // Fire once per due date: the first sweep that sees this item at
    // REMIND_DAYS_BEFORE-or-fewer days left (and hasn't already reminded for
    // THIS SPECIFIC due date) sends the single reminder. If the due date
    // later changes (e.g. calibration gets done and a new date is set),
    // reminded_for_due_date no longer matches, so a fresh single reminder
    // will fire again for the new date.
    const isWithinReminderWindow = daysLeft <= REMIND_DAYS_BEFORE;
    const alreadyRemindedForThisDueDate = row.reminded_for_due_date === row.next_calibration_date;

    if (!isWithinReminderWindow || alreadyRemindedForThisDueDate) continue;

    const { subject, text } = buildMessage({ ...row, daysLeft });

    const emailResult = await sendEmail(row.customer_email, subject, text);
    logNotification.run(row.id, row.customer_name, 'email', row.customer_email || '', emailResult.status, emailResult.detail);

    const smsResult = await sendSMS(row.customer_phone, text);
    logNotification.run(row.id, row.customer_name, 'sms', row.customer_phone || '', smsResult.status, smsResult.detail);

    // Only mark this due date as "reminded" if the email actually went out.
    // If it failed (SMTP hiccup, no email on file, etc.), leave it unmarked
    // so tomorrow's sweep retries automatically instead of silently giving
    // up forever. SMS success/failure doesn't block this — SMS can keep
    // retrying independently (e.g. while a Sender ID approval is pending)
    // without causing duplicate emails once email has already gone out.
    const emailSucceeded = emailResult.status.startsWith('sent');
    if (emailSucceeded) {
      markReminded.run(today, row.next_calibration_date, row.id);
      notifiedCount++;
    } else {
      console.warn(`Email reminder FAILED for ${row.customer_name} (equipment #${row.id}) — will retry on the next sweep. Detail: ${emailResult.detail}`);
    }

    console.log(`Reminded ${row.customer_name} about ${row.brand} ${row.equipment_type} (due ${row.next_calibration_date}) — email: ${emailResult.status}, sms: ${smsResult.status}`);
  }

  return { checked: rows.length, notified: notifiedCount };
}

function startScheduler() {
  // Runs every day at 8:00 AM server time. Change the cron string to adjust timing.
  cron.schedule('0 8 * * *', () => {
    console.log('Running scheduled calibration notification sweep...');
    runNotificationSweep().catch(err => console.error('Sweep failed:', err));
  });
  console.log(`Notification scheduler started (daily at 08:00, reminding ${REMIND_DAYS_BEFORE} days before due date, once per due date).`);
}

module.exports = { startScheduler, runNotificationSweep };