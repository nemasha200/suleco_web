const cron = require('node-cron');
const db = require('../db');
const { daysUntil } = require('./dates');
const { sendEmail, sendSMS, buildMessage } = require('./notify');

// How many days before the due date to start sending reminders
const REMIND_WITHIN_DAYS = Number(process.env.REMIND_WITHIN_DAYS) || 14;

const logNotification = db.prepare(`
  INSERT INTO notification_log (equipment_id, customer_name, channel, target, status, detail)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const markNotified = db.prepare(`
  UPDATE equipment SET last_notified_date = ? WHERE id = ?
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

    const isDueOrOverdue = daysLeft <= REMIND_WITHIN_DAYS;
    const alreadyNotifiedToday = row.last_notified_date === today;

    if (!isDueOrOverdue || alreadyNotifiedToday) continue;

    const { subject, text } = buildMessage({ ...row, daysLeft });

    const emailResult = await sendEmail(row.customer_email, subject, text);
    logNotification.run(row.id, row.customer_name, 'email', row.customer_email || '', emailResult.status, emailResult.detail);

    const smsResult = await sendSMS(row.customer_phone, text);
    logNotification.run(row.id, row.customer_name, 'sms', row.customer_phone || '', smsResult.status, smsResult.detail);

    markNotified.run(today, row.id);
    notifiedCount++;

    console.log(`Notified ${row.customer_name} about ${row.brand} ${row.model} — email: ${emailResult.status}, sms: ${smsResult.status}`);
  }

  return { checked: rows.length, notified: notifiedCount };
}

function startScheduler() {
  // Runs every day at 8:00 AM server time. Change the cron string to adjust timing.
  cron.schedule('0 8 * * *', () => {
    console.log('Running scheduled calibration notification sweep...');
    runNotificationSweep().catch(err => console.error('Sweep failed:', err));
  });
  console.log('Notification scheduler started (daily at 08:00).');
}

module.exports = { startScheduler, runNotificationSweep };
