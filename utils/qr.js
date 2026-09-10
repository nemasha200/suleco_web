const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db');
const { getBaseUrl } = require('./baseUrl');

// Every piece of equipment already carries a unique, unguessable
// `response_token` (see db.js). We reuse it as the QR key, so the scan link
// can't be guessed by walking through /q/1, /q/2, /q/3...
//
// db.js only backfills tokens at startup, so equipment added while the server
// is running might not have one yet. This makes sure a token always exists
// before we build a QR out of it.
function ensureEquipmentToken(equipmentId) {
  const row = db.prepare('SELECT id, response_token FROM equipment WHERE id = ?').get(equipmentId);
  if (!row) return null;

  if (row.response_token && row.response_token.trim() !== '') {
    return row.response_token;
  }

  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE equipment SET response_token = ? WHERE id = ?').run(token, equipmentId);
  return token;
}

// The address the phone lands on after scanning.
function publicEquipmentUrl(req, token) {
  return `${getBaseUrl(req)}/q/${token}`;
}

// Shared look for every QR we produce: high error-correction ('H') so the code
// still scans if the printed sticker gets scuffed, oiled or partly covered — a
// realistic worry for labels stuck on survey instruments.
const QR_OPTIONS = {
  errorCorrectionLevel: 'H',
  type: 'png',
  width: 600,
  margin: 2,
  color: {
    dark: '#0A3648',   // --navy, matches the app's branding
    light: '#FFFFFF',
  },
};

async function qrPngBuffer(text) {
  return QRCode.toBuffer(text, QR_OPTIONS);
}

async function qrDataUrl(text) {
  return QRCode.toDataURL(text, { ...QR_OPTIONS, type: 'image/png', width: 320 });
}

// Turns a serial number into something safe to use as a download filename.
function safeFileName(value, fallback) {
  const cleaned = (value || '').toString().trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned || fallback;
}

module.exports = {
  ensureEquipmentToken,
  publicEquipmentUrl,
  qrPngBuffer,
  qrDataUrl,
  safeFileName,
};