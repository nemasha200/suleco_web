// ---------------------------------------------------------------------------
// SMS TEMPLATE — one short line, nothing else.
//
// SMS is billed per 160-character segment and read on a lock screen, so it
// carries only the four things a customer needs to act:
//   1. who is contacting them
//   2. which instrument (the serial number identifies it exactly)
//   3. when it is due
//   4. the number to call
// No greeting, no customer name, no explanation — those live in the email.
//
// Keep it that way when editing. Every character added here costs money on
// every reminder, and going one character over 160 doubles the bill.
// ---------------------------------------------------------------------------

const { COMPANY, CONTACT, dueState } = require('./messageBase');

const SMS_SEGMENT = 160;

function buildSmsMessage(row) {
  const { overdue, date } = dueState(row);
  const serial = row.serial_number ? ` S/N ${row.serial_number}` : '';
  const phone = CONTACT.phoneDial || COMPANY.phoneDial;
  const type = row.equipment_type || row.brand || 'Equipment';

  const compose = (t) => overdue
    ? `${COMPANY.shortName}: ${t}${serial} calibration OVERDUE (due ${date}). Call ${phone}.`
    : `${COMPANY.shortName}: ${t}${serial} calibration due ${date}. Call ${phone}.`;

  // Only the equipment description is shortened if a long name overflows —
  // the serial number alone still identifies the instrument. The company name,
  // serial, due date and phone number are never cut.
  const text = compose(type);
  return text.length <= SMS_SEGMENT ? text : compose('Equipment');
}

module.exports = { buildSmsMessage, SMS_SEGMENT };