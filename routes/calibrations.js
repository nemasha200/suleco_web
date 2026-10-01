const express = require('express');
const router = express.Router();
const db = require('../db');
const { syncEquipmentCalibrationDates } = require('../utils/syncEquipmentCalibration');
const { calcTotals } = require('../utils/money');
const { buildJobCard } = require('../utils/jobCard');
const {
  ensureEquipmentToken, publicEquipmentUrl, qrPngBuffer, safeFileName,
} = require('../utils/qr');

// ✅ ALERT COUNT FUNCTION (error-safe for missing notifications table)
function getAlertCount() {
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM notifications 
      WHERE read_status = 0 OR read_status IS NULL
    `).get();
    return result ? result.count : 0;
  } catch (err) {
    return 0;
  }
}

// Calibration Description is a user-extendable dropdown, same pattern as
// Equipment Type / Brand / Model on the equipment form — stored in the
// shared dropdown_options table so anything typed as "+ Add new" sticks
// around for future use. Technicians use the same mechanism.
function getOptions(fieldName) {
  return db.prepare(
    'SELECT value FROM dropdown_options WHERE field_name = ? ORDER BY value COLLATE NOCASE ASC'
  ).all(fieldName).map(r => r.value);
}

function addOptionIfMissing(fieldName, value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return;
  db.prepare('INSERT OR IGNORE INTO dropdown_options (field_name, value) VALUES (?, ?)').run(fieldName, trimmed);
}

function resolveOptionValue(selectValue, newValue, fieldName) {
  if (selectValue === '__new__') {
    const trimmed = (newValue || '').trim();
    if (trimmed) addOptionIfMissing(fieldName, trimmed);
    return trimmed;
  }
  return selectValue || '';
}

const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Pulls repeatable {description[], amount[]} array pairs out of the
// request body for one line-item group (services / spare parts / repairs),
// skipping any row where both fields were left empty.
function collectLineItems(descriptions, amounts) {
  const descArr = toArray(descriptions);
  const amtArr = toArray(amounts);

  return descArr
    .map((desc, i) => ({
      description: (desc || '').trim(),
      amount: amtArr[i] !== undefined && amtArr[i] !== '' ? Number(amtArr[i]) : null,
    }))
    .filter((item) => item.description !== '' || item.amount !== null);
}

function insertLineItems(calibrationId, itemType, items) {
  if (items.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO calibration_line_items (calibration_id, item_type, description, amount)
    VALUES (?, ?, ?, ?)
  `);
  items.forEach((item) => insert.run(calibrationId, itemType, item.description, item.amount));
}

// The technician dropdown is repeatable ("+ Add another technician"), and a
// row may be an existing name or a newly typed one. Stored as a comma-joined
// string on the calibration — a join table would be overkill for a name list.
function collectTechnicians(body) {
  const picked = toArray(body.technician);
  const typed = toArray(body.technician_new);

  const names = picked.map((value, i) => {
    if (value === '__new__') {
      const trimmed = (typed[i] || '').trim();
      if (trimmed) addOptionIfMissing('technician', trimmed);
      return trimmed;
    }
    return (value || '').trim();
  }).filter(Boolean);

  return [...new Set(names)].join(', ');
}

// Everything the workflow page needs about one record, in one place.
function loadWorkflow(id) {
  const calibration = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.model,
           equipment.equipment_type, equipment.sold_by_us, equipment.purchase_date,
           equipment.warranty_period_months,
           customers.name AS customer_name, customers.company AS customer_company
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    WHERE calibrations.id = ?
  `).get(id);

  if (!calibration) return null;

  const lineItems = db.prepare(
    'SELECT * FROM calibration_line_items WHERE calibration_id = ? ORDER BY id ASC'
  ).all(id);

  const subtotal = lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  return {
    calibration,
    services: lineItems.filter(i => i.item_type === 'service'),
    spareParts: lineItems.filter(i => i.item_type === 'spare_part'),
    repairItems: lineItems.filter(i => i.item_type === 'repair'),
    totals: calcTotals(subtotal, calibration.discount),
  };
}

// List all calibration records, most recent first
router.get('/', (req, res) => {
  const calibrations = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.equipment_type,
           customers.name AS customer_name
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY calibrations.id DESC
  `).all();

  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render('calibrations/list', {
    calibrations,
    username: req.session.username || 'admin',
    activeNav: 'services',
    alertCount: getAlertCount(),
    flash,
  });
});

// ---------------------------------------------------------------------------
// GROUP 1 — Check In
// The only thing this page collects is serial number, check-in date and
// service description. Everything else happens later, on the workflow page.
// ---------------------------------------------------------------------------
router.get('/new', (req, res) => {
  const equipmentList = db.prepare(`
    SELECT equipment.*, customers.name AS customer_name, customers.company AS customer_company
    FROM equipment
    JOIN customers ON customers.id = equipment.customer_id
    ORDER BY equipment.serial_number ASC
  `).all();

  // Past "done" dates per equipment, so the form can show calibration history
  // once a serial number is picked.
  const pastCalibrations = db.prepare(`
    SELECT equipment_id, done_date FROM calibrations
    WHERE done_date IS NOT NULL AND done_date != ''
    ORDER BY done_date DESC
  `).all();

  const doneDatesByEquipment = {};
  pastCalibrations.forEach((row) => {
    if (!doneDatesByEquipment[row.equipment_id]) doneDatesByEquipment[row.equipment_id] = [];
    doneDatesByEquipment[row.equipment_id].push(row.done_date);
  });

  // Jobs checked in but not finished. This is what makes the workflow survive
  // logging out: come back tomorrow and the half-done jobs are listed here,
  // each linking straight to the stage it stopped at.
  const pending = db.prepare(`
    SELECT calibrations.id, calibrations.stage, calibrations.check_in_date, calibrations.description,
           equipment.serial_number, equipment.brand, equipment.equipment_type,
           customers.name AS customer_name
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    WHERE calibrations.stage IN ('approval', 'service')
    ORDER BY calibrations.id DESC
  `).all();

  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render('calibrations/form', {
    equipmentList,
    doneDatesByEquipment,
    descriptionOptions: getOptions('calibration_description'),
    pending,
    // Set when the search box sent the user here with a serial already
    // identified — the form selects it on load so they can go straight on.
    prefillEquipmentId: req.query.equipment_id || '',
    username: req.session.username || 'admin',
    activeNav: 'services',
    alertCount: getAlertCount(),
    flash,
  });
});

router.post('/new', (req, res) => {
  const { equipment_id, check_in_date, description, description_new } = req.body;

  if (!equipment_id) return res.redirect('/calibrations/new');

  const finalDescription = resolveOptionValue(description, description_new, 'calibration_description');

  // Created at stage 'approval': check-in is finished, approval is what's next.
  const result = db.prepare(`
    INSERT INTO calibrations (equipment_id, description, check_in_date, stage, done, repair)
    VALUES (?, ?, ?, 'approval', 'No', 'No')
  `).run(equipment_id, finalDescription, check_in_date || null);

  req.session.flash = 'Checked in. Complete the approval step to start the service.';
  res.redirect(`/calibrations/${result.lastInsertRowid}/workflow`);
});

// ---------------------------------------------------------------------------
// GROUPS 2 and 3 — Approval, then Service
// One page that shows the check-in summary as read-only, then whichever stage
// this record has reached.
// ---------------------------------------------------------------------------
router.get('/:id/workflow', (req, res) => {
  const data = loadWorkflow(req.params.id);
  if (!data) return res.redirect('/calibrations');

  const flash = req.session.flash || null;
  delete req.session.flash;

  res.render('calibrations/workflow', {
    ...data,
    technicianOptions: getOptions('technician'),
    username: req.session.username || 'admin',
    activeNav: 'services',
    alertCount: getAlertCount(),
    flash,
  });
});

// Group 2 — Approval. The boxes get ticked at different times: a PO today, a
// quotation next week. Each one stamps the date it was first ticked.
//
// Three ways out of this step:
//   Save         — record progress, job stays here
//   Start Service— move to Group 3
//   Save & Exit  — released without service; the job ends here
router.post('/:id/approval', (req, res) => {
  const before = db.prepare(`
    SELECT equipment_return_date, quotation_sent_date, po_received_date
    FROM calibrations WHERE id = ?
  `).get(req.params.id);
  if (!before) return res.redirect('/calibrations');

  const box = (value) => (value ? 'Yes' : 'No');
  const today = new Date().toISOString().split('T')[0];

  // The TOGGLE is the decision, not which button was pressed. If it is on, the
  // job is released whichever save is used — otherwise pressing plain Save
  // with the toggle on would quietly discard it and leave the job in the
  // queue, which is the bug this replaces.
  const releasing = !!req.body.released_without_service;
  const action = releasing ? 'release' : req.body.action;   // 'save' | 'start' | 'release'

  // Keep the date from when the box was FIRST ticked — re-saving the form
  // later must not move it to today. Unticking clears it.
  const stamp = (ticked, existing) => (ticked ? (existing || today) : null);

  db.prepare(`
    UPDATE calibrations
    SET equipment_return = ?, equipment_return_date = ?,
        quotation_sent = ?, quotation_sent_date = ?,
        po_received = ?, po_received_date = ?,
        approval_updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    box(req.body.equipment_return), stamp(req.body.equipment_return, before.equipment_return_date),
    box(req.body.quotation_sent), stamp(req.body.quotation_sent, before.quotation_sent_date),
    box(req.body.po_received), stamp(req.body.po_received, before.po_received_date),
    req.params.id
  );

  // Released without service: closed at approval. stage 'done' is what drops
  // it out of Jobs in progress; the record itself stays in Services.
  if (action === 'release') {
    db.prepare(`
      UPDATE calibrations
      SET released_without_service = 'Yes', released_date = ?, stage = 'done'
      WHERE id = ?
    `).run(today, req.params.id);

    req.session.flash = 'Equipment released without service. The job is closed and has left the in-progress list.';
    return res.redirect('/calibrations');
  }

  // Toggle off: make sure an earlier release is not left on the record.
  db.prepare(`
    UPDATE calibrations SET released_without_service = 'No', released_date = NULL WHERE id = ?
  `).run(req.params.id);

  // stage and approved_at only move on an explicit Start Service, so saving
  // partial approval progress can never start the job by accident.
  if (action === 'start') {
    db.prepare(`
      UPDATE calibrations
      SET approved_at = datetime('now', 'localtime'), stage = 'service',
          released_without_service = 'No', released_date = NULL
      WHERE id = ?
    `).run(req.params.id);
  }

  req.session.flash = action === 'start'
    ? 'Approval recorded. Service started.'
    : 'Approval progress saved. The job stays at this step until you start the service.';
  res.redirect(`/calibrations/${req.params.id}/workflow`);
});

// Group 3 — Service. Technician(s) plus everything through Done Date, saved
// in one go, which also completes the record.
router.post('/:id/service', (req, res) => {
  const { id } = req.params;
  const calibration = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(id);
  if (!calibration) return res.redirect('/calibrations');

  const isDone = req.body.done === 'Yes';
  const isRepair = req.body.repair === 'Yes';

  db.prepare(`
    UPDATE calibrations
    SET technicians = ?, discount = ?, done = ?, status = ?, done_date = ?, repair = ?, stage = 'done'
    WHERE id = ?
  `).run(
    collectTechnicians(req.body),
    Number(req.body.discount) || 0,
    isDone ? 'Yes' : 'No',
    req.body.status || '',
    req.body.done_date || null,
    isRepair ? 'Yes' : 'No',
    id
  );

  // Wipe and re-insert rather than diffing old rows against new ones.
  db.prepare('DELETE FROM calibration_line_items WHERE calibration_id = ?').run(id);
  if (isDone) {
    insertLineItems(id, 'service', collectLineItems(req.body.service_description, req.body.service_amount));
  }
  if (isRepair) {
    insertLineItems(id, 'spare_part', collectLineItems(req.body.spare_part_description, req.body.spare_part_amount));
    insertLineItems(id, 'repair', collectLineItems(req.body.repair_item_description, req.body.repair_item_amount));
  }

  // Keep the equipment record's own calibration dates in sync — always
  // recomputed from the TRUE most recent Done record on file, not just
  // this one, so this stays correct no matter what order records are added.
  syncEquipmentCalibrationDates(calibration.equipment_id);

  req.session.flash = 'Service record saved.';
  res.redirect(`/calibrations/${id}/workflow`);
});

// ---------------------------------------------------------------------------
// Printable job card (PDF)
//
// Same record as the workflow page, but with the customer's contact details
// joined in as well — a job card that travels with the instrument needs the
// phone numbers on it.
// ---------------------------------------------------------------------------
router.get('/:id/jobcard.pdf', (req, res) => {
  const calibration = db.prepare(`
    SELECT calibrations.*, equipment.serial_number, equipment.brand, equipment.model,
           equipment.equipment_type, equipment.sold_by_us, equipment.warranty_period_months,
           customers.name AS customer_name, customers.company AS customer_company,
           customers.phone AS customer_phone, customers.phone2 AS customer_phone2,
           customers.email AS customer_email, customers.email2 AS customer_email2
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    JOIN customers ON customers.id = equipment.customer_id
    WHERE calibrations.id = ?
  `).get(req.params.id);

  if (!calibration) return res.status(404).send('Service record not found.');

  const lineItems = db.prepare(
    'SELECT * FROM calibration_line_items WHERE calibration_id = ? ORDER BY id ASC'
  ).all(req.params.id);

  const safeSerial = (calibration.serial_number || 'record').replace(/[^a-z0-9_-]+/gi, '_');
  const fileName = `JobCard_${String(calibration.id).padStart(5, '0')}_${safeSerial}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  // ?inline=1 opens it in the browser's viewer; the plain URL downloads.
  res.setHeader(
    'Content-Disposition',
    req.query.inline === '1' ? `inline; filename="${fileName}"` : `attachment; filename="${fileName}"`
  );

  buildJobCard(res, {
    calibration,
    services: lineItems.filter(i => i.item_type === 'service'),
    spareParts: lineItems.filter(i => i.item_type === 'spare_part'),
    repairItems: lineItems.filter(i => i.item_type === 'repair'),
  });
});

// ---------------------------------------------------------------------------
// QR code download — the button in the Action column of the calibrations list.
//
// The QR is generated per EQUIPMENT (not per calibration row), because what a
// technician wants when scanning a sticker on an instrument is that
// instrument's whole story: its details plus every calibration ever logged
// against it. Two calibration rows for the same serial number therefore
// produce the same QR — which is correct, they're the same physical machine.
// ---------------------------------------------------------------------------
router.get('/:id/qr.png', async (req, res) => {
  const calibration = db.prepare(`
    SELECT calibrations.id, calibrations.equipment_id,
           equipment.serial_number, equipment.equipment_type, equipment.brand
    FROM calibrations
    JOIN equipment ON equipment.id = calibrations.equipment_id
    WHERE calibrations.id = ?
  `).get(req.params.id);

  if (!calibration) return res.status(404).send('Calibration record not found.');

  try {
    const token = ensureEquipmentToken(calibration.equipment_id);
    if (!token) return res.status(404).send('Equipment not found.');

    const url = publicEquipmentUrl(req, token);
    const png = await qrPngBuffer(url);

    const fileName = `QR_${safeFileName(calibration.serial_number, 'equipment')}.png`;

    res.setHeader('Content-Type', 'image/png');
    // ?inline=1 shows the image in the browser instead of downloading it —
    // used by the preview box on the equipment page. The plain URL (what the
    // Action-column button uses) always downloads.
    res.setHeader(
      'Content-Disposition',
      req.query.inline === '1' ? `inline; filename="${fileName}"` : `attachment; filename="${fileName}"`
    );
    res.send(png);
  } catch (err) {
    console.error('QR generation failed:', err);
    res.status(500).send('Could not generate QR code.');
  }
});

// Edit an existing calibration record. Uses the same loader as the workflow
// page, so the edit form can show every stage's fields and the tax totals.
router.get('/:id/edit', (req, res) => {
  const data = loadWorkflow(req.params.id);
  if (!data) return res.redirect('/calibrations');

  res.render('calibrations/edit', {
    ...data,
    descriptionOptions: getOptions('calibration_description'),
    technicianOptions: getOptions('technician'),
    username: req.session.username || 'admin',
    activeNav: 'services',
    alertCount: getAlertCount(),
  });
});

router.post('/:id/edit', (req, res) => {
  const {
    description, description_new, done, status, done_date, repair,
  } = req.body;
  const isDone = done === 'Yes';
  const isRepair = repair === 'Yes';
  const { id } = req.params;

  const calibration = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(id);
  if (!calibration) return res.redirect('/calibrations');

  const finalDescription = resolveOptionValue(description, description_new, 'calibration_description');

  // Every stage's fields are editable here, dates included — this is the
  // screen for correcting a date that was recorded wrong. stage is NOT touched
  // by an ordinary edit; a finished record shouldn't jump back into the queue.
  const box = (value) => (value ? 'Yes' : 'No');

  // A date only counts while its box is ticked, so unticking clears it rather
  // than leaving an orphan date on the record.
  const dateFor = (ticked, value) => (ticked ? (value || null) : null);

  db.prepare(`
    UPDATE calibrations
    SET description = ?, check_in_date = ?,
        equipment_return = ?, equipment_return_date = ?,
        quotation_sent = ?, quotation_sent_date = ?,
        po_received = ?, po_received_date = ?,
        released_without_service = ?, released_date = ?,
        technicians = ?, discount = ?, done = ?, status = ?, done_date = ?, repair = ?
    WHERE id = ?
  `).run(
    finalDescription,
    req.body.check_in_date || null,
    box(req.body.equipment_return), dateFor(req.body.equipment_return, req.body.equipment_return_date),
    box(req.body.quotation_sent), dateFor(req.body.quotation_sent, req.body.quotation_sent_date),
    box(req.body.po_received), dateFor(req.body.po_received, req.body.po_received_date),
    box(req.body.released_without_service), dateFor(req.body.released_without_service, req.body.released_date),
    collectTechnicians(req.body),
    Number(req.body.discount) || 0,
    isDone ? 'Yes' : 'No',
    status || '',
    done_date || null,
    isRepair ? 'Yes' : 'No',
    id
  );

  // Simplest correct approach for repeatable line items: wipe and re-insert
  // whatever was submitted, rather than trying to diff old vs new rows.
  db.prepare('DELETE FROM calibration_line_items WHERE calibration_id = ?').run(id);
  if (isDone) {
    insertLineItems(id, 'service', collectLineItems(req.body.service_description, req.body.service_amount));
  }
  if (isRepair) {
    insertLineItems(id, 'spare_part', collectLineItems(req.body.spare_part_description, req.body.spare_part_amount));
    insertLineItems(id, 'repair', collectLineItems(req.body.repair_item_description, req.body.repair_item_amount));
  }

  // Marking a job as released here closes it, same as Save & Exit does on the
  // workflow page — otherwise it would keep sitting in Jobs in progress.
  if (req.body.released_without_service && calibration.stage !== 'done') {
    db.prepare("UPDATE calibrations SET stage = 'done' WHERE id = ?").run(id);
  }

  // Keep the equipment record's own calibration dates in sync — always
  // recomputed from the TRUE most recent Done record on file. This is the
  // fix: editing an OLD historical calibration record no longer overwrites
  // the equipment's real next-due date with a stale/older value.
  syncEquipmentCalibrationDates(calibration.equipment_id);

  req.session.flash = 'Calibration record updated.';
  res.redirect('/calibrations');
});

router.post('/:id/delete', (req, res) => {
  const calibration = db.prepare('SELECT equipment_id FROM calibrations WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM calibrations WHERE id = ?').run(req.params.id);

  // If the deleted record was the most recent Done calibration, the
  // equipment's next-due date needs to fall back to whatever is now the
  // true most recent one on file (or clear, if none remain).
  if (calibration) {
    syncEquipmentCalibrationDates(calibration.equipment_id);
  }

  req.session.flash = 'Calibration record deleted.';
  res.redirect('/calibrations');
});

module.exports = router;
