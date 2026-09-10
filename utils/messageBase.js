// ---------------------------------------------------------------------------
// Shared ground for BOTH message templates.
// Company identity and the few facts every message needs live here, so the
// email and SMS templates can be edited independently without either one
// drifting on the company name, the phone number, or how "overdue" is decided.
// Nothing about wording or layout belongs in this file.
// ---------------------------------------------------------------------------

const { getBaseUrl } = require('./baseUrl');

const COMPANY = {
  name: process.env.COMPANY_NAME || 'Suleco (Pvt) Ltd',
  division: process.env.COMPANY_DIVISION || 'Technical Division',
  team: process.env.COMPANY_TEAM || 'Technical Service Team',
  shortName: process.env.COMPANY_SHORT_NAME || 'SULECO',
  phone: process.env.COMPANY_PHONE || '+94 112875050',
  phoneDial: process.env.COMPANY_PHONE_DIAL || '0112875050',
  email: process.env.COMPANY_EMAIL || 'sales@suleco.lk',
  address: process.env.COMPANY_ADDRESS || 'No.44, Beddagana South, Pitakotte, Sri Lanka',
};

// The named person a client should ask for when they call about a service.
// If TECH_CONTACT_PHONE is blank it falls back to the main company number,
// so a message is never missing a way to reply.
const CONTACT = {
  name: process.env.TECH_CONTACT_NAME || '',
  phone: process.env.TECH_CONTACT_PHONE || COMPANY.phone,
  phoneDial: process.env.TECH_CONTACT_PHONE_DIAL || process.env.TECH_CONTACT_PHONE || COMPANY.phoneDial,
};

// "Alpha kk Auto Level" — brand, model and type joined, skipping blanks.
function equipmentLabel(row) {
  return [row.brand, row.model, row.equipment_type].filter(Boolean).join(' ') || 'equipment';
}

// One place decides what "overdue" means, so the email and the SMS can never
// disagree about the same instrument.
function dueState(row) {
  const overdue = row.daysLeft !== null && row.daysLeft < 0;
  return {
    overdue,
    days: row.daysLeft === null ? null : Math.abs(row.daysLeft),
    date: row.next_calibration_date || 'an unrecorded date',
  };
}

// The public read-only record page (same one the QR sticker opens). Only
// returned when a token exists — a fake one would lead to a dead page.
function recordUrl(row) {
  if (!row.response_token) return null;
  return `${getBaseUrl(null)}/q/${row.response_token}`;
}

module.exports = { COMPANY, CONTACT, equipmentLabel, dueState, recordUrl };