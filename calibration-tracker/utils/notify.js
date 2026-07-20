const nodemailer = require('nodemailer');
const twilio = require('twilio');

// --- Email transport (Gmail, Zoho, Office365, any SMTP provider works) ---
const transporter = (process.env.SMTP_HOST && process.env.SMTP_USER)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

// --- SMS transport (Twilio) ---
const twilioClient = (process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function sendEmail(to, subject, text) {
  if (!to) return { status: 'skipped', detail: 'no email on file' };
  if (!transporter) return { status: 'skipped', detail: 'SMTP not configured' };
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    return { status: 'sent', detail: null };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { status: 'failed', detail: err.message };
  }
}

async function sendSMS(to, body) {
  if (!to) return { status: 'skipped', detail: 'no phone on file' };
  if (!twilioClient) return { status: 'skipped', detail: 'Twilio not configured' };
  try {
    await twilioClient.messages.create({
      to: normalizePhone(to),
      from: process.env.TWILIO_FROM_NUMBER,
      body,
    });
    return { status: 'sent', detail: null };
  } catch (err) {
    console.error('SMS send failed:', err.message);
    return { status: 'failed', detail: err.message };
  }
}

// Basic Sri Lankan local-number handling: turns "0703010152" into "+94703010152".
// Adjust or remove this if your customers use a different country's numbers.
function normalizePhone(phone) {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('0')) return '+94' + trimmed.slice(1);
  return trimmed;
}

function buildMessage(row) {
  const overdue = row.daysLeft !== null && row.daysLeft < 0;
  const dueText = overdue
    ? `is OVERDUE for calibration (was due ${row.next_calibration_date})`
    : `is due for calibration on ${row.next_calibration_date}`;

  const subject = `Calibration reminder: ${row.brand || ''} ${row.model || ''}`.trim();
  const text = `Hi ${row.customer_name},\n\nYour equipment (${row.brand || ''} ${row.model || ''}, S/N ${row.serial_number || 'N/A'}) ${dueText}.\nPlease contact us to schedule calibration.\n\nThank you.`;

  return { subject, text };
}

module.exports = { sendEmail, sendSMS, buildMessage };
