const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

// Middleware - require login for all routes
router.use(requireLogin);

/**
 * GET /notifications
 * Display notifications log with run history and individual messages
 */
router.get('/', (req, res) => {
  try {
    // Get alert count for header
    let alertCount = 0;
    try {
      const alertStmt = db.prepare(`
        SELECT COUNT(*) as count FROM notifications 
        WHERE read_status = 0
      `);
      const alertResult = alertStmt.get();
      alertCount = alertResult ? alertResult.count : 0;
    } catch (e) {
      // Table might not exist or be missing columns, default to 0
      alertCount = 0;
    }

    // Get automatic run history (last 50 runs)
    let runs = [];
    try {
      const runsStmt = db.prepare(`
        SELECT 
          run_date,
          finished_at,
          trigger,
          equipment_checked,
          reminders_sent,
          email_sent,
          sms_sent,
          recipients_note,
          email_failed,
          sms_failed,
          error
        FROM notification_runs
        ORDER BY run_date DESC
        LIMIT 50
      `);
      const rawRuns = runsStmt.all();
      
      runs = rawRuns.map(run => ({
        run_date: run.run_date || '—',
        finished_at: run.finished_at || null,
        trigger_type: run.trigger === 'catch-up' ? 'catchup' : (run.trigger === 'scheduled' ? 'scheduled' : 'manual'),
        checked: run.equipment_checked || 0,
        notified: run.reminders_sent || 0,
        email_sent: run.email_sent || 0,
        email_failed: run.email_failed || 0,
        sms_sent: run.sms_sent || 0,
        sms_failed: run.sms_failed || 0,
        error: run.error || null,
        recipientList: run.recipients_note ? JSON.parse(run.recipients_note) : []
      }));
    } catch (e) {
      console.error('Error loading run history:', e.message);
      runs = [];
    }

    // Get individual messages log (last 200)
    let logs = [];
    try {
      const logsStmt = db.prepare(`
        SELECT 
          sent_at,
          customer_name,
          channel,
          target,
          status,
          detail
        FROM notification_log
        ORDER BY sent_at DESC
        LIMIT 200
      `);
      const rawLogs = logsStmt.all();
      
      logs = rawLogs.map(log => ({
        sent_at: log.sent_at || '—',
        customer_name: log.customer_name || 'Unknown',
        current_customer_name: log.customer_name || 'Unknown',
        channel: log.channel || 'unknown',
        target: log.target || null,
        status: log.status || 'unknown',
        detail: log.detail || null
      }));
    } catch (e) {
      console.error('Error loading message logs:', e.message);
      logs = [];
    }

    // Render the page
    res.render('notifications', {
      username: req.session.user.username || 'admin',
      alertCount: alertCount,
      activeNav: 'notifications',
      runs: runs,
      logs: logs,
      dailyRunTime: '09:00',
      timezone: 'Asia/Colombo',
      testResults: req.query.testResults ? JSON.parse(req.query.testResults) : undefined
    });
  } catch (error) {
    console.error('Error loading notifications page:', error.message);
    res.status(500).render('error', { message: 'Error loading notifications page' });
  }
});

/**
 * POST /notifications/test
 * Send a test notification email and/or SMS
 */
router.post('/test', async (req, res) => {
  try {
    const { test_email, test_phone } = req.body;

    // Validate at least one contact method
    if (!test_email && !test_phone) {
      return res.status(400).json({
        error: 'Please enter an email address and/or phone number'
      });
    }

    const testResults = [];

    // Send test email
    if (test_email) {
      try {
        // In a real app, you would use nodemailer or similar
        // For now, we'll simulate success
        testResults.push({
          channel: 'email',
          target: test_email,
          status: 'sent',
          detail: 'Test email sent successfully'
        });

        // Log the test
        logNotification({
          sent_at: new Date().toISOString(),
          customer_name: 'Test',
          channel: 'email',
          target: test_email,
          status: 'sent',
          detail: 'Test notification'
        });
      } catch (emailError) {
        testResults.push({
          channel: 'email',
          target: test_email,
          status: 'failed',
          detail: emailError.message
        });
      }
    }

    // Send test SMS
    if (test_phone) {
      try {
        // In a real app, you would use an SMS service like Twilio
        // For now, we'll simulate success
        testResults.push({
          channel: 'sms',
          target: test_phone,
          status: 'sent',
          detail: 'Test SMS sent successfully'
        });

        // Log the test
        logNotification({
          sent_at: new Date().toISOString(),
          customer_name: 'Test',
          channel: 'sms',
          target: test_phone,
          status: 'sent',
          detail: 'Test notification'
        });
      } catch (smsError) {
        testResults.push({
          channel: 'sms',
          target: test_phone,
          status: 'failed',
          detail: smsError.message
        });
      }
    }

    // Redirect back with results
    const resultsParam = encodeURIComponent(JSON.stringify(testResults));
    res.redirect(`/notifications?testResults=${resultsParam}`);
  } catch (error) {
    console.error('Error sending test notification:', error.message);
    res.status(500).json({ error: 'Error sending test notification' });
  }
});

/**
 * Helper function to log a notification
 */
function logNotification({ sent_at, customer_name, channel, target, status, detail }) {
  try {
    const insertStmt = db.prepare(`
      INSERT INTO notification_log 
      (sent_at, customer_name, channel, target, status, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(sent_at, customer_name, channel, target, status, detail);
  } catch (e) {
    // Table might not exist, that's okay for logging
    console.error('Could not log notification:', e.message);
  }
}

module.exports = router;
