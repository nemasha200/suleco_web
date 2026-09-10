// ---------------------------------------------------------------------------
// EMAIL TEMPLATE — subject, plain-text body and HTML body.
//
// Email has no length cost and is often filed or forwarded to a manager, so it
// carries the full approved reminder letter, the complete equipment record and
// the service contact details.
//
// IMPORTANT: the plain-text and HTML versions are both sent. Mail clients that
// render HTML show the formatted card; anything that doesn't falls back to the
// text. Edit ONE and the other goes stale — always change both.
// ---------------------------------------------------------------------------

const { COMPANY, CONTACT, equipmentLabel, dueState, recordUrl } = require('./messageBase');

function buildEmailMessage(row) {
  const { overdue, days, date } = dueState(row);
  const label = equipmentLabel(row);
  const link = recordUrl(row);
  const serialSuffix = row.serial_number ? ` (S/N ${row.serial_number})` : '';

  const subject = overdue
    ? `Service / Calibration OVERDUE - ${label}${serialSuffix}`
    : `Service / Calibration due ${date} - ${label}${serialSuffix}`;

  // The one sentence that changes with the instrument's status.
  const dueSentence = overdue
    ? `We would like to kindly remind you that the service/calibration of your survey equipment - ${label}${serialSuffix} - was due on ${date}${days !== null ? ` and is now ${days} day${days === 1 ? '' : 's'} overdue` : ''}.`
    : `We would like to kindly remind you that the service/calibration of your survey equipment - ${label}${serialSuffix} - is due on ${date}${days !== null ? ` — ${days} day${days === 1 ? '' : 's'} from now` : ''}.`;

  const fields = [
    ['Equipment Type', row.equipment_type],
    ['Brand', row.brand],
    ['Model', row.model],
    ['Serial Number', row.serial_number],
    ['Last Calibration', row.last_calibration_date],
    ['Next Calibration', row.next_calibration_date],
  ].filter(([, v]) => v);

  // ---- Plain-text version ----
  const pad = Math.max(...fields.map(([k]) => k.length));
  const text = [
    `${COMPANY.name.toUpperCase()} — ${COMPANY.division.toUpperCase()}`,
    `Service / Calibration Reminder`,
    ``,
    `Dear Valued Customer,`,
    ``,
    `Greetings from ${COMPANY.name}.`,
    ``,
    dueSentence,
    ``,
    `Regular servicing and calibration are essential to maintain the accuracy,`,
    `reliability, and optimal performance of your equipment and to ensure`,
    `compliance with applicable technical requirements and standards.`,
    ``,
    `We kindly request you to make the necessary arrangements for the`,
    `service/calibration within the due period. Please contact our`,
    `${COMPANY.team} to schedule the service at a convenient time.`,
    ``,
    `EQUIPMENT DETAILS`,
    ...fields.map(([k, v]) => `  ${k.padEnd(pad)} : ${v}`),
    ``,
    `${COMPANY.team.toUpperCase()}`,
    ...(CONTACT.name ? [`  Name         : ${CONTACT.name}`] : []),
    `  Contact No.  : ${CONTACT.phone}`,
    `  Email        : ${COMPANY.email}`,
    `  Address      : ${COMPANY.address}`,
    ...(link ? ['', 'View the full service record for this instrument:', `  ${link}`] : []),
    ``,
    `Should you require any further information or assistance, please do not`,
    `hesitate to contact our ${COMPANY.team}.`,
    ``,
    `Thank you for choosing ${COMPANY.name}. We appreciate your continued trust`,
    `in our technical services and support.`,
    ``,
    `Best regards,`,
    `${COMPANY.team}`,
    `${COMPANY.name}`,
    ``,
    `---`,
    `This is an automated reminder. If this instrument has already been`,
    `serviced or calibrated, please let us know so we can update our records.`,
  ].join('\n');

  // ---- HTML version ----
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const accent = overdue ? '#C0392B' : '#1AA9BC';
  const rows = fields.map(([k, v]) => `
          <tr>
            <td style="padding:7px 0;color:#5B6470;font-size:13px;width:45%;">${esc(k)}</td>
            <td style="padding:7px 0;color:#1F2430;font-size:14px;font-weight:600;">${esc(v)}</td>
          </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F2F7F4;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F7F4;padding:20px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #DEE4EC;">

        <tr><td style="background:#0A3648;padding:20px 24px;">
          <div style="color:#ffffff;font-size:18px;font-weight:700;">${esc(COMPANY.name)}</div>
          <div style="color:#1AA9BC;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-top:2px;">${esc(COMPANY.division)}</div>
        </td></tr>

        <tr><td style="padding:24px;">
          <div style="display:inline-block;background:${accent};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:5px 12px;border-radius:999px;">
            ${overdue ? 'Service / Calibration Overdue' : 'Service / Calibration Due Soon'}
          </div>

          <p style="font-size:15px;color:#1F2430;margin:18px 0 0;">Dear Valued Customer,</p>

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:12px 0 0;">
            Greetings from ${esc(COMPANY.name)}.
          </p>

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:12px 0 0;">
            ${esc(dueSentence)}
          </p>

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:12px 0 0;">
            Regular servicing and calibration are essential to maintain the accuracy, reliability, and
            optimal performance of your equipment and to ensure compliance with applicable technical
            requirements and standards.
          </p>

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:12px 0 0;">
            We kindly request you to make the necessary arrangements for the service/calibration within
            the due period. Please contact our ${esc(COMPANY.team)} to schedule the service at a
            convenient time.
          </p>

          <div style="margin-top:22px;border:1px solid #DEE4EC;border-radius:10px;padding:4px 16px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#0A3648;padding:12px 0 4px;">Equipment Details</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
            </table>
            <div style="height:8px;"></div>
          </div>

          <div style="margin-top:22px;padding-top:18px;border-top:1px solid #DEE4EC;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#0A3648;margin-bottom:8px;">${esc(COMPANY.team)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${CONTACT.name ? `<tr>
                <td style="padding:5px 0;color:#5B6470;font-size:13px;width:35%;">Name</td>
                <td style="padding:5px 0;color:#1F2430;font-size:14px;font-weight:600;">${esc(CONTACT.name)}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:5px 0;color:#5B6470;font-size:13px;width:35%;">Contact No.</td>
                <td style="padding:5px 0;font-size:14px;font-weight:600;">
                  <a href="tel:${esc(CONTACT.phoneDial)}" style="color:#0A3648;text-decoration:none;">${esc(CONTACT.phone)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:5px 0;color:#5B6470;font-size:13px;">Email</td>
                <td style="padding:5px 0;font-size:14px;font-weight:600;">
                  <a href="mailto:${esc(COMPANY.email)}" style="color:#0A3648;text-decoration:none;">${esc(COMPANY.email)}</a>
                </td>
              </tr>
              <tr>
                <td style="padding:5px 0;color:#5B6470;font-size:13px;">Address</td>
                <td style="padding:5px 0;color:#5B6470;font-size:13px;">${esc(COMPANY.address)}</td>
              </tr>
            </table>
          </div>

          ${link ? `<p style="margin:20px 0 0;">
            <a href="${esc(link)}" style="display:inline-block;background:#1AA9BC;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:8px;">View full service record</a>
          </p>` : ''}

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:22px 0 0;">
            Should you require any further information or assistance, please do not hesitate to contact
            our ${esc(COMPANY.team)}.
          </p>

          <p style="font-size:14px;color:#46505E;line-height:1.6;margin:12px 0 0;">
            Thank you for choosing ${esc(COMPANY.name)}. We appreciate your continued trust in our
            technical services and support.
          </p>

          <p style="font-size:14px;color:#1F2430;margin:22px 0 0;">
            Best regards,<br>
            <strong>${esc(COMPANY.team)}</strong><br>
            <span style="color:#5B6470;">${esc(COMPANY.name)}</span>
          </p>
        </td></tr>

        <tr><td style="background:#EEF1F6;padding:14px 24px;">
          <div style="font-size:11px;color:#5B6470;line-height:1.5;">
            This is an automated reminder. If this instrument has already been serviced or calibrated,
            please let us know so we can update our records.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

module.exports = { buildEmailMessage };