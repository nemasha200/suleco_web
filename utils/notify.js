// ---------------------------------------------------------------------------
// DELIVERY ONLY — how a message gets out, not what it says.
//
// Wording and layout live in their own files:
//   utils/emailTemplate.js  — subject, text body, HTML body
//   utils/smsTemplate.js    — the single SMS line
//   utils/messageBase.js    — company identity shared by both
//
// Nothing customer-facing should be written in this file. If you are here to
// change how a reminder reads, you are in the wrong file.
// ---------------------------------------------------------------------------

const nodemailer = require('nodemailer');
const { COMPANY, CONTACT } = require('./messageBase');
const { buildEmailMessage } = require('./emailTemplate');
const { buildSmsMessage } = require('./smsTemplate');

// --- Email transport ---
// If real SMTP settings are in .env, use them (actually delivers email).
// If not, lazily spin up a free Ethereal test inbox the first time an email
// is sent, with a preview link so you can see what would have been delivered.
let cachedTransporter = null;
let usingTestInbox = false;

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      // Force IPv4 — on some Windows machines, Node tries IPv6 first and
      // hangs waiting for Gmail's greeting, causing a false "Greeting never
      // received" failure. Generous timeouts so a slow network fails clearly
      // rather than hanging indefinitely.
      family: 4,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    return cachedTransporter;
  }

  try {
    const testAccount = await nodemailer.createTestAccount();
    usingTestInbox = true;
    cachedTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log('SMTP not configured — using a temporary Ethereal test inbox for email.');
    console.log(`Ethereal login (optional, to browse the inbox directly): ${testAccount.user} / ${testAccount.pass}`);
    return cachedTransporter;
  } catch (err) {
    console.error('Could not create Ethereal test inbox:', err.message);
    return null;
  }
}

// --- SMS transport (Text.lk — Sri Lankan SMS gateway) ---
// Sign up at https://app.text.lk/, get an API key + approved Sender ID,
// and set TEXTLK_API_KEY and TEXTLK_SENDER_ID in .env.
const TEXTLK_API_KEY = process.env.TEXTLK_API_KEY;
const TEXTLK_SENDER_ID = process.env.TEXTLK_SENDER_ID;
const TEXTLK_ENDPOINT = 'https://app.text.lk/api/v3/sms/send';

// `html` is optional. When supplied, the message goes out as multipart:
// clients that render HTML show the formatted version, and anything that
// doesn't falls back to `text`. Both carry the same information.
async function sendEmail(to, subject, text, html) {
  if (!to) return { status: 'skipped', detail: 'no email on file' };

  const transporter = await getTransporter();
  if (!transporter) return { status: 'skipped', detail: 'SMTP not configured' };

  try {
    const info = await transporter.sendMail({
      // A display name makes the sender read as "Suleco Technical Division"
      // in the client's inbox rather than a bare gmail address.
      from: process.env.SMTP_FROM
        || `"${COMPANY.name} ${COMPANY.division}" <${process.env.SMTP_USER || 'noreply@calibration-tracker.local'}>`,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });

    if (usingTestInbox) {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      return { status: 'sent (TEST)', detail: previewUrl || 'sent to test inbox' };
    }
    return { status: 'sent', detail: null };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { status: 'failed', detail: err.message };
  }
}

async function sendSMS(to, body) {
  if (!to) return { status: 'skipped', detail: 'no phone on file' };

  if (!TEXTLK_API_KEY || !TEXTLK_SENDER_ID) {
    return {
      status: 'not sent (no SMS gateway)',
      detail: `Text.lk not configured. Message would read: "${body}"`,
    };
  }

  try {
    const response = await fetch(TEXTLK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEXTLK_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        recipient: normalizePhoneForTextLk(to),
        sender_id: TEXTLK_SENDER_ID,
        type: 'plain',
        message: body,
      }),
    });

    const data = await response.json();

    if (data.status === 'success') {
      return { status: 'sent', detail: null };
    }
    return { status: 'failed', detail: data.message || 'Text.lk rejected the request' };
  } catch (err) {
    console.error('SMS send failed:', err.message);
    return { status: 'failed', detail: err.message };
  }
}

// Sri Lankan mobile number handling for Text.lk, which expects numbers
// WITHOUT a leading + (e.g. "94703010152"). Customers' numbers get stored
// in a mix of formats, so normalize each case:
//   +94703010152   -> 94703010152
//   0703010152      -> 94703010152
//   703010152       -> 94703010152 (9 digits, missing the leading 0)
function normalizePhoneForTextLk(phone) {
  const trimmed = phone.trim().replace(/[\s-]/g, '');
  if (trimmed.startsWith('+94')) return trimmed.slice(1);
  if (trimmed.startsWith('94') && trimmed.length === 11) return trimmed;
  if (trimmed.startsWith('0') && trimmed.length === 10) return '94' + trimmed.slice(1);
  if (/^[7-9]\d{8}$/.test(trimmed)) return '94' + trimmed;
  return trimmed;
}

// Kept so any older code calling buildMessage() still works. New code should
// require the template files directly.
function buildMessage(row) {
  const email = buildEmailMessage(row);
  return { ...email, sms: buildSmsMessage(row) };
}

// The template builders are re-exported so existing requires of this file keep
// working unchanged — scheduler.js and routes/dashboard.js need no edits.
module.exports = {
  sendEmail,
  sendSMS,
  buildMessage,
  buildEmailMessage,
  buildSmsMessage,
  COMPANY,
  CONTACT,
};