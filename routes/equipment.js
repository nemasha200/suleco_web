const express = require('express');
const router = express.Router();
const db = require('../db');
const QRCode = require('qrcode');
const { requireLogin } = require('../middleware/auth');

// ============ HELPERS ============

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

// ============ ROUTES ============

// List all equipment - THIS IS THE FIX: Removed e.qr_code from SELECT
router.get('/', requireLogin, (req, res) => {
  try {
    const equipment = db.prepare(`
      SELECT 
        e.id, e.customer_id, c.name as customer_name, c.phone as customer_phone,
        e.equipment_type, e.brand, e.model, e.serial_number, e.sold_by_us,
        e.last_calibration_date, e.next_calibration_date, e.status
      FROM equipment e
      LEFT JOIN customers c ON e.customer_id = c.id
      ORDER BY c.name, e.serial_number
    `).all();

    const equipmentWithDetails = equipment.map(e => {
      const nextDate = e.next_calibration_date ? new Date(e.next_calibration_date) : null;
      const today = new Date();
      const daysUntil = nextDate ? Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24)) : null;
      const isOverdue = daysUntil !== null && daysUntil < 0;
      const isDueSoon = daysUntil !== null && daysUntil >= 0 && daysUntil <= 180;

      return {
        ...e,
        badge: isOverdue ? { label: 'OVERDUE!', className: 'bg-danger' } : isDueSoon ? { label: `Due in ${daysUntil}d`, className: 'bg-warning' } : null
      };
    });

    const alertCount = getAlertCount();

    res.render('equipment/list', {
      equipment: equipmentWithDetails,
      username: req.session.username,
      activeNav: 'equipment',
      alertCount,
      flash: req.query.flash || null
    });
  } catch (err) {
    console.error('Equipment list error:', err.message);
    res.status(500).send('Error loading equipment list: ' + err.message);
  }
});

// Show new equipment form
router.get('/new', requireLogin, (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT id, name, company, phone, email, phone2, email2,
        (SELECT COUNT(*) FROM equipment WHERE customer_id = customers.id) as equipment_count
      FROM customers ORDER BY name
    `).all();
    
    const alertCount = getAlertCount();

    const equipmentTypes = db.prepare(`SELECT DISTINCT equipment_type FROM equipment WHERE equipment_type IS NOT NULL ORDER BY equipment_type`).all().map(r => r.equipment_type);
    const brands = db.prepare(`SELECT DISTINCT brand FROM equipment WHERE brand IS NOT NULL ORDER BY brand`).all().map(r => r.brand);
    const models = db.prepare(`SELECT DISTINCT model FROM equipment WHERE model IS NOT NULL ORDER BY model`).all().map(r => r.model);
    const warrantyOptions = [12, 24, 36, 48, 60];

    const equipment = db.prepare(`
      SELECT 
        e.id, e.customer_id, c.name as customer_name, c.phone as customer_phone,
        e.equipment_type, e.brand, e.model, e.serial_number, e.sold_by_us,
        e.last_calibration_date, e.next_calibration_date, e.purchase_date, e.warranty_period_months, e.status
      FROM equipment e
      LEFT JOIN customers c ON e.customer_id = c.id
      ORDER BY e.next_calibration_date ASC, e.last_calibration_date DESC
    `).all();

    const equipmentWithDetails = equipment.map(e => {
      const nextDate = e.next_calibration_date ? new Date(e.next_calibration_date) : null;
      const today = new Date();
      const daysUntil = nextDate ? Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24)) : null;
      const isOverdue = daysUntil !== null && daysUntil < 0;
      const isDueSoon = daysUntil !== null && daysUntil >= 0 && daysUntil <= 180;

      return {
        ...e,
        badge: isOverdue ? { label: 'OVERDUE!', className: 'bg-danger' } : isDueSoon ? { label: `Due in ${daysUntil}d`, className: 'bg-warning' } : null
      };
    });

    const lastEquipmentByCustomer = {};
    customers.forEach(cust => {
      const lastEq = db.prepare(`SELECT equipment_type, brand, model FROM equipment WHERE customer_id = ? ORDER BY id DESC LIMIT 1`).get(cust.id);
      if (lastEq) lastEquipmentByCustomer[cust.id] = lastEq;
    });

    res.render('equipment/form', {
      equipment: null,
      existingCustomers: customers,
      equipmentTypes,
      brands,
      models,
      warrantyOptions,
      allEquipment: equipmentWithDetails,
      lastEquipmentByCustomer,
      username: req.session.username,
      activeNav: 'equipment',
      alertCount
    });
  } catch (err) {
    console.error('Equipment form error:', err.message);
    res.status(500).send('Error loading form: ' + err.message);
  }
});

// Add new equipment
router.post('/new', requireLogin, (req, res) => {
  try {
    const { customer_id } = req.body;
    const equipment_type_arr = Array.isArray(req.body.equipment_type) ? req.body.equipment_type : [req.body.equipment_type];
    const equipment_type_new_arr = Array.isArray(req.body.equipment_type_new) ? req.body.equipment_type_new : [req.body.equipment_type_new];
    const brand_arr = Array.isArray(req.body.brand) ? req.body.brand : [req.body.brand];
    const brand_new_arr = Array.isArray(req.body.brand_new) ? req.body.brand_new : [req.body.brand_new];
    const model_arr = Array.isArray(req.body.model) ? req.body.model : [req.body.model];
    const model_new_arr = Array.isArray(req.body.model_new) ? req.body.model_new : [req.body.model_new];
    const serial_number_arr = Array.isArray(req.body.serial_number) ? req.body.serial_number : [req.body.serial_number];
    const sold_by_us_arr = Array.isArray(req.body.sold_by_us) ? req.body.sold_by_us : [req.body.sold_by_us];
    const purchase_date_arr = Array.isArray(req.body.purchase_date) ? req.body.purchase_date : [req.body.purchase_date];
    const warranty_period_months_arr = Array.isArray(req.body.warranty_period_months) ? req.body.warranty_period_months : [req.body.warranty_period_months];

    const insertStmt = db.prepare(`
      INSERT INTO equipment (customer_id, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < serial_number_arr.length; i++) {
      const eq_type = equipment_type_arr[i] === '__new__' ? equipment_type_new_arr[i] : equipment_type_arr[i];
      const br = brand_arr[i] === '__new__' ? brand_new_arr[i] : brand_arr[i];
      const md = model_arr[i] === '__new__' ? model_new_arr[i] : model_arr[i];
      const sn = serial_number_arr[i];
      const soldByUs = sold_by_us_arr[i] || 'No';
      const purchaseDate = purchase_date_arr[i] || null;
      const warrantyMonths = warranty_period_months_arr[i] || null;

      if (!sn) continue;

      insertStmt.run(customer_id, eq_type, br, md, sn, soldByUs, purchaseDate, warrantyMonths);
    }

    // REDIRECT TO EQUIPMENT LIST WITH SUCCESS MESSAGE
    res.redirect('/equipment?flash=Equipment%20added%20successfully');
  } catch (err) {
    console.error('Insert error:', err.message);
    res.status(500).send('Error adding equipment: ' + err.message);
  }
});

// View equipment details
router.get('/:id/view', requireLogin, (req, res) => {
  try {
    const equipment = db.prepare(`
      SELECT 
        e.id, e.customer_id, c.name as customer_name, c.company as customer_company, 
        c.phone as customer_phone, c.email as customer_email,
        e.equipment_type, e.brand, e.model, e.serial_number, e.sold_by_us,
        e.last_calibration_date, e.next_calibration_date, e.purchase_date, 
        e.warranty_period_months, e.status
      FROM equipment e
      LEFT JOIN customers c ON e.customer_id = c.id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!equipment) return res.status(404).send('Equipment not found');

    const calibrations = db.prepare(`
      SELECT id, description, done, status, done_date, calibration_date
      FROM calibrations 
      WHERE equipment_id = ? 
      ORDER BY done_date DESC, calibration_date DESC
    `).all(req.params.id);

    const qrImage = null; // Skip QR code for now since column may not exist
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
    const scanUrl = `${publicBaseUrl}/equipment/${equipment.id}/scan`;

    const alertCount = getAlertCount();

    res.render('equipment/view-detail', {
      equipment,
      calibrations,
      qrImage,
      scanUrl,
      username: req.session.username,
      activeNav: 'equipment',
      alertCount
    });
  } catch (err) {
    console.error('View error:', err.message);
    res.status(500).send('Error loading equipment: ' + err.message);
  }
});

// Show edit equipment form
router.get('/:id/edit', requireLogin, (req, res) => {
  try {
    const equipment = db.prepare(`
      SELECT * FROM equipment WHERE id = ?
    `).get(req.params.id);

    if (!equipment) return res.status(404).send('Equipment not found');

    const customers = db.prepare(`
      SELECT id, name, company, phone, email, phone2, email2,
        (SELECT COUNT(*) FROM equipment WHERE customer_id = customers.id) as equipment_count
      FROM customers ORDER BY name
    `).all();

    const equipmentTypes = db.prepare(`SELECT DISTINCT equipment_type FROM equipment WHERE equipment_type IS NOT NULL ORDER BY equipment_type`).all().map(r => r.equipment_type);
    const brands = db.prepare(`SELECT DISTINCT brand FROM equipment WHERE brand IS NOT NULL ORDER BY brand`).all().map(r => r.brand);
    const models = db.prepare(`SELECT DISTINCT model FROM equipment WHERE model IS NOT NULL ORDER BY model`).all().map(r => r.model);
    const warrantyOptions = [12, 24, 36, 48, 60];

    const allEquipment = db.prepare(`
      SELECT 
        e.id, e.customer_id, c.name as customer_name,
        e.equipment_type, e.brand, e.model, e.serial_number, e.sold_by_us,
        e.last_calibration_date, e.next_calibration_date, e.purchase_date, e.warranty_period_months, e.status
      FROM equipment e
      LEFT JOIN customers c ON e.customer_id = c.id
      WHERE e.id != ?
      ORDER BY e.next_calibration_date ASC, e.last_calibration_date DESC
    `).all(req.params.id);

    const equipmentWithDetails = allEquipment.map(e => {
      const nextDate = e.next_calibration_date ? new Date(e.next_calibration_date) : null;
      const today = new Date();
      const daysUntil = nextDate ? Math.ceil((nextDate - today) / (1000 * 60 * 60 * 24)) : null;
      const isOverdue = daysUntil !== null && daysUntil < 0;
      const isDueSoon = daysUntil !== null && daysUntil >= 0 && daysUntil <= 180;

      return {
        ...e,
        badge: isOverdue ? { label: 'OVERDUE!', className: 'bg-danger' } : isDueSoon ? { label: `Due in ${daysUntil}d`, className: 'bg-warning' } : null
      };
    });

    const alertCount = getAlertCount();

    res.render('equipment/form', {
      equipment,
      existingCustomers: customers,
      equipmentTypes,
      brands,
      models,
      warrantyOptions,
      allEquipment: equipmentWithDetails,
      username: req.session.username,
      activeNav: 'equipment',
      alertCount
    });
  } catch (err) {
    console.error('Edit form error:', err.message);
    res.status(500).send('Error loading edit form: ' + err.message);
  }
});

// Update equipment
router.post('/:id/edit', requireLogin, (req, res) => {
  try {
    const { customer_id, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months } = req.body;

    db.prepare(`
      UPDATE equipment 
      SET customer_id = ?, equipment_type = ?, brand = ?, model = ?, serial_number = ?, 
          sold_by_us = ?, purchase_date = ?, warranty_period_months = ?
      WHERE id = ?
    `).run(customer_id, equipment_type, brand, model, serial_number, sold_by_us, purchase_date, warranty_period_months, req.params.id);

    res.redirect('/equipment?flash=Equipment%20updated%20successfully');
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).send('Error updating equipment: ' + err.message);
  }
});

// Delete equipment
router.post('/:id/delete', requireLogin, (req, res) => {
  try {
    db.prepare(`DELETE FROM calibrations WHERE equipment_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM equipment WHERE id = ?`).run(req.params.id);

    res.redirect('/equipment?flash=Equipment%20deleted%20successfully');
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).send('Error deleting equipment: ' + err.message);
  }
});

// QR code scan view (public)
router.get('/:id/scan', (req, res) => {
  try {
    const equipment = db.prepare(`
      SELECT 
        e.id, e.customer_id, c.name as customer_name, c.company as customer_company, c.phone as customer_phone, c.email as customer_email,
        e.equipment_type, e.brand, e.model, e.serial_number, e.sold_by_us,
        e.last_calibration_date, e.next_calibration_date, e.purchase_date, e.warranty_period_months
      FROM equipment e
      LEFT JOIN customers c ON e.customer_id = c.id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!equipment) return res.status(404).send('Equipment not found');

    const calibrations = db.prepare(`
      SELECT id, description, done, status, done_date 
      FROM calibrations 
      WHERE equipment_id = ? 
      ORDER BY done_date DESC, calibration_date DESC
    `).all(req.params.id);

    res.render('equipment/scan', { equipment, calibrations });
  } catch (err) {
    console.error('Scan view error:', err.message);
    res.status(500).send('Error: ' + err.message);
  }
});

module.exports = router;
