const express = require('express');
const router = express.Router();
const db = require('../db');
const { calibrationBadge, daysUntil } = require('../utils/dates');
const { runNotificationSweep } = require('../utils/scheduler');
const { sendEmail, sendSMS } = require('../utils/notify');

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

  res.render('dashboard', {
    equipment: withBadges,
    overdueCount,
    dueSoonCount,
    totalCount,
    username: req.session.username,
    flash,
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

// Manually trigger the reminder sweep right now (button on the dashboard)
router.post('/notify-now', async (req, res) => {
  try {
    const result = await runNotificationSweep();
    req.session.flash = `Checked ${result.checked} item(s), sent reminders for ${result.notified}.`;
  } catch (err) {
    console.error('Manual notify sweep failed:', err);
    req.session.flash = 'Notification sweep failed — check server logs.';
  }
  res.redirect('/');
});

// View a log of recently sent notifications
router.get('/notifications', (req, res) => {
  const logs = db.prepare(`
    SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT 200
  `).all();
  res.render('notifications', { logs, username: req.session.username, testResults: null });
});

// Send an on-demand test email/SMS to any address/number you type in
router.post('/notifications/test', async (req, res) => {
  const { test_email, test_phone } = req.body;
  const subject = 'Calibration Tracker — Test Notification';
  const text = 'This is a test message from Calibration Tracker, confirming your notification setup is working.';

  const testResults = [];

  if (test_email && test_email.trim()) {
    const result = await sendEmail(test_email.trim(), subject, text);
    testResults.push({ channel: 'email', target: test_email.trim(), ...result });
  }
  if (test_phone && test_phone.trim()) {
    const result = await sendSMS(test_phone.trim(), text);
    testResults.push({ channel: 'sms', target: test_phone.trim(), ...result });
  }

  const logs = db.prepare(`
    SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT 200
  `).all();

  res.render('notifications', { logs, username: req.session.username, testResults });
});

module.exports = router;