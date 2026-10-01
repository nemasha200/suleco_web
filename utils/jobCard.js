const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { calcTotals, money } = require('./money');

// ---------------------------------------------------------------------------
// Service job card PDF.
//
// Laid out as a paper form a technician can carry: who and what at the top,
// the three workflow stages in order, the itemised bill, then signature lines.
// Everything comes from the record — nothing is typed twice.
// ---------------------------------------------------------------------------

const NAVY = '#15333f';
const GOLD = '#c39b6e';
const GREY = '#1d497a';
const LINE = '#D9E0E8';

const PAGE_MARGIN = 45;
const LOGO = path.join(__dirname, '..', 'public', 'images', 'suleco-logo-nav.png');

function dash(value) {
  const v = (value === null || value === undefined) ? '' : String(value).trim();
  return v === '' ? '—' : v;
}

// A two-column block of label/value pairs. Returns the y position it ended at
// so the caller can carry on underneath without guessing heights.
function fieldGrid(doc, pairs, top) {
  const colWidth = (doc.page.width - PAGE_MARGIN * 2) / 2;
  let y = top;

  pairs.forEach(([label, value], i) => {
    const col = i % 2;
    const x = PAGE_MARGIN + col * colWidth;
    if (col === 0 && i > 0) y += 26;

    doc.fontSize(7.5).fillColor(GREY).font('Helvetica')
       .text(label.toUpperCase(), x, y, { width: colWidth - 12 });
    doc.fontSize(10).fillColor('#111').font('Helvetica-Bold')
       .text(dash(value), x, y + 11, { width: colWidth - 12 });
  });

  return y + 26;
}

function sectionHeading(doc, text, y) {
  doc.rect(PAGE_MARGIN, y, doc.page.width - PAGE_MARGIN * 2, 18).fill(NAVY);
  doc.fontSize(8.5).fillColor('#fff').font('Helvetica-Bold')
     .text(text.toUpperCase(), PAGE_MARGIN + 10, y + 5);
  return y + 24;
}

// Ticked / not-ticked row for the approval stage.
function checkRow(doc, items, y) {
  let x = PAGE_MARGIN;
  items.forEach(([label, ticked]) => {
    doc.rect(x, y, 11, 11).lineWidth(1).strokeColor(ticked ? NAVY : LINE).stroke();
    if (ticked) {
      doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold').text('X', x + 2.5, y + 1.5);
    }
    doc.fontSize(9.5).fillColor('#111').font('Helvetica').text(label, x + 17, y + 1);
    x += doc.widthOfString(label) + 46;
  });
  return y + 24;
}

// One itemised group (services / spare parts / repairs). Skipped entirely when
// the group is empty, so a calibration-only job doesn't print empty tables.
function itemTable(doc, title, items, y) {
  if (!items || items.length === 0) return y;

  const right = doc.page.width - PAGE_MARGIN;
  doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold').text(title, PAGE_MARGIN, y);
  y += 15;

  doc.moveTo(PAGE_MARGIN, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 6;

  items.forEach((item) => {
    doc.fontSize(9.5).fillColor('#111').font('Helvetica')
       .text(dash(item.description), PAGE_MARGIN + 4, y, { width: right - PAGE_MARGIN - 110 });
    doc.font('Helvetica-Bold')
       .text(item.amount === null || item.amount === undefined ? '—' : money(item.amount),
             right - 105, y, { width: 100, align: 'right' });
    y += Math.max(13, doc.heightOfString(dash(item.description), { width: right - PAGE_MARGIN - 110 }) + 3);
  });

  return y + 8;
}

function totalsBlock(doc, totals, y) {
  const right = doc.page.width - PAGE_MARGIN;
  const boxLeft = right - 240;

  doc.moveTo(boxLeft, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 8;

  const line = (label, value, bold) => {
    doc.fontSize(bold ? 11 : 9.5)
       .fillColor(bold ? NAVY : GREY)
       .font(bold ? 'Helvetica-Bold' : 'Helvetica')
       .text(label, boxLeft, y, { width: 130 });
    doc.fillColor(bold ? NAVY : '#111')
       .font('Helvetica-Bold')
       .text(`Rs. ${money(value)}`, boxLeft + 130, y, { width: 110, align: 'right' });
    y += bold ? 17 : 13;
  };

  line('Subtotal', totals.base);
  if (totals.discount > 0) line('Discount', -totals.discount);
  line('Net Amount', totals.net);
  line(`SSCL (${totals.ssclLabel})`, totals.sscl);
  line(`VAT (${totals.vatLabel})`, totals.vat);

  doc.moveTo(boxLeft, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 8;
  line('FINAL TOTAL', totals.total, true);

  return y + 6;
}

function signatureBlock(doc, y) {
  const width = (doc.page.width - PAGE_MARGIN * 2 - 40) / 2;

  [['Technician', PAGE_MARGIN], ['Customer', PAGE_MARGIN + width + 40]].forEach(([label, x]) => {
    doc.moveTo(x, y + 26).lineTo(x + width, y + 26).lineWidth(0.5).strokeColor('#9AA7B4').stroke();
    doc.fontSize(8).fillColor(GREY).font('Helvetica')
       .text(`${label} — name, signature & date`, x, y + 31, { width });
  });

  return y + 46;
}

/**
 * Streams a job card PDF for one calibration record into `res`.
 * `data` is what loadJobCard() in routes/calibrations.js assembles.
 */
function buildJobCard(res, data) {
  const { calibration: c, services, spareParts, repairItems } = data;
  const totals = calcTotals(
    [...services, ...spareParts, ...repairItems]
      .reduce((sum, i) => sum + (Number(i.amount) || 0), 0),
    c.discount
  );

  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
  doc.pipe(res);

  // ---- Header ----
  let y = PAGE_MARGIN;
  if (fs.existsSync(LOGO)) {
    try { doc.image(LOGO, PAGE_MARGIN, y - 4, { height: 26 }); } catch { /* logo is optional */ }
  }

  doc.fontSize(17).fillColor(NAVY).font('Helvetica-Bold')
     .text('SERVICE JOB CARD', PAGE_MARGIN, y, { align: 'right' });
  doc.fontSize(9).fillColor(GREY).font('Helvetica')
     .text(`Job No. ${String(c.id).padStart(5, '0')}`, { align: 'right' });
  doc.text(`Printed ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`,
     { align: 'right' });

  y += 42;
  doc.moveTo(PAGE_MARGIN, y).lineTo(doc.page.width - PAGE_MARGIN, y)
     .lineWidth(2).strokeColor(GOLD).stroke();
  y += 14;

  // ---- Customer & equipment ----
  y = sectionHeading(doc, 'Customer & Equipment', y);
  y = fieldGrid(doc, [
    ['Company / Client', c.customer_name],
    ['Contact', [c.customer_phone, c.customer_phone2].filter(Boolean).join('  /  ')],
    ['Address', c.customer_company],
    ['Email', [c.customer_email, c.customer_email2].filter(Boolean).join('  /  ')],
    ['Serial Number', c.serial_number],
    ['Equipment Type', c.equipment_type],
    ['Brand', c.brand],
    ['Model', c.model],
    ['Sold by Us', c.sold_by_us],
    ['Warranty', c.warranty_period_months ? `${c.warranty_period_months} months` : ''],
  ], y) + 6;

  // ---- Stage 1 ----
  y = sectionHeading(doc, 'Group 1 — Check In', y);
  y = fieldGrid(doc, [
    ['Check In Date', c.check_in_date],
    ['Service Description', c.description],
  ], y) + 6;

  // ---- Stage 2 ----
  y = sectionHeading(doc, 'Group 2 — Approval', y);
  y = checkRow(doc, [
    ['Equipment Return', c.equipment_return === 'Yes'],
    ['Quotation Sent', c.quotation_sent === 'Yes'],
    ['PO Received', c.po_received === 'Yes'],
  ], y);
  if (c.approved_at) {
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica')
       .text(`Service started ${c.approved_at}`, PAGE_MARGIN, y);
    y += 14;
  }
  y += 4;

  // ---- Stage 3 ----
  y = sectionHeading(doc, 'Group 3 — Service', y);
  y = fieldGrid(doc, [
    ['Technician(s)', c.technicians],
    ['Calibration Done', c.done],
    ['Status', c.status],
    ['Done Date', c.done_date],
  ], y) + 6;

  y = itemTable(doc, 'Calibration Services', services, y);
  y = itemTable(doc, 'Spare Part Replacement', spareParts, y);
  y = itemTable(doc, 'Repair Work', repairItems, y);

  // Keep the money and the signatures together on one page.
  if (y > doc.page.height - 215) {
    doc.addPage();
    y = PAGE_MARGIN;
  }

  y = totalsBlock(doc, totals, y + 4);
  y = signatureBlock(doc, y + 18);

  doc.fontSize(7.5).fillColor(GREY).font('Helvetica')
     .text('SULECO (Pvt) Ltd · No.44, Beddagana South, Pitakotte, Sri Lanka · +94 112875050 · sales@suleco.lk',
           PAGE_MARGIN, doc.page.height - 58,
           { width: doc.page.width - PAGE_MARGIN * 2, align: 'center' });

  doc.end();
}

module.exports = { buildJobCard };
