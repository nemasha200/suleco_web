const express = require('express');
const router = express.Router();
const db = require('../db');

const REMIND_DAYS_BEFORE = Number(process.env.REMIND_DAYS_BEFORE) || 7;

const requeueDueReminders = db.prepare(`
  UPDATE equipment
  SET reminded_for_due_date = NULL
  WHERE customer_id = ?
    AND next_calibration_date IS NOT NULL
    AND next_calibration_date <= date('now', '+' || ? || ' days')
`);

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

router.get('/', (req, res) => {
  const customers = db.prepare(`
    SELECT customers.*, COUNT(equipment.id) AS equipment_count
    FROM customers
    LEFT JOIN equipment ON equipment.customer_id = customers.id
    GROUP BY customers.id
    ORDER BY customers.name ASC
  `).all();
  
  res.render('customers/list', { 
    customers, 
    username: req.session.username || 'admin',
    activeNav: 'customers',
    alertCount: getAlertCount()
  });
});

router.get('/new', (req, res) => {
  const flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  
  res.render('customers/form', {
    customer: null,
    prefillName: req.query.name || '',
    existingCustomers: db.prepare(
      'SELECT id, name, company, phone, email FROM customers ORDER BY name ASC'
    ).all(),
    username: req.session.username || 'admin',
    activeNav: 'customers',
    alertCount: getAlertCount(),
    flash: flash
  });
});

router.post('/new', (req, res) => {
  const { name, email, phone, company } = req.body;
  
  if (!name || !email) {
    req.session.flash = 'Name and email are required.';
    return res.redirect('/customers/new');
  }
  
  try {
    db.prepare(
      'INSERT INTO customers (name, email, phone, company, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
    ).run(name, email, phone || '', company || '');
    
    req.session.flash = 'Customer added successfully.';
    res.redirect('/customers');
  } catch (err) {
    console.error('Error adding customer:', err);
    req.session.flash = 'Error adding customer.';
    res.redirect('/customers/new');
  }
});

router.get('/:id/edit', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  
  const flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  
  res.render('customers/form', { 
    customer,
    username: req.session.username || 'admin',
    activeNav: 'customers',
    alertCount: getAlertCount(),
    flash: flash
  });
});

router.post('/:id/edit', (req, res) => {
  const { name, email, phone, company } = req.body;
  
  if (!name || !email) {
    req.session.flash = 'Name and email are required.';
    return res.redirect(`/customers/${req.params.id}/edit`);
  }
  
  const before = db.prepare(
    'SELECT phone, email FROM customers WHERE id = ?'
  ).get(req.params.id);
  
  if (!before) return res.redirect('/customers');

  try {
    db.prepare(
      'UPDATE customers SET name = ?, email = ?, phone = ?, company = ? WHERE id = ?'
    ).run(name, email, phone || '', company || '', req.params.id);

    const contactChanged =
      (before.phone || '') !== (phone || '') ||
      (before.email || '') !== (email || '');

    if (contactChanged) {
      const requeued = requeueDueReminders.run(req.params.id, REMIND_DAYS_BEFORE).changes;
      if (requeued > 0) {
        req.session.flash = `Contact updated. ${requeued} reminder(s) will be re-sent.`;
      }
    } else {
      req.session.flash = 'Customer updated successfully.';
    }

    res.redirect('/customers');
  } catch (err) {
    console.error('Error updating customer:', err);
    req.session.flash = 'Error updating customer.';
    res.redirect(`/customers/${req.params.id}/edit`);
  }
});

router.post('/:id/delete', (req, res) => {
  try {
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    req.session.flash = 'Customer deleted.';
  } catch (err) {
    console.error('Error deleting customer:', err);
    req.session.flash = 'Error deleting customer.';
  }
  res.redirect('/customers');
});

module.exports = router;
