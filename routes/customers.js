const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  const customers = db.prepare(`
    SELECT customers.*, COUNT(equipment.id) AS equipment_count
    FROM customers
    LEFT JOIN equipment ON equipment.customer_id = customers.id
    GROUP BY customers.id
    ORDER BY customers.name ASC
  `).all();
  res.render('customers/list', { customers, username: req.session.username });
});

router.get('/new', (req, res) => {
  res.render('customers/form', { customer: null, username: req.session.username });
});

router.post('/new', (req, res) => {
  const { name, company, phone, email } = req.body;
  db.prepare('INSERT INTO customers (name, company, phone, email) VALUES (?, ?, ?, ?)')
    .run(name, company, phone, email);
  res.redirect('/customers');
});

router.get('/:id/edit', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  res.render('customers/form', { customer, username: req.session.username });
});

router.post('/:id/edit', (req, res) => {
  const { name, company, phone, email } = req.body;
  db.prepare('UPDATE customers SET name = ?, company = ?, phone = ?, email = ? WHERE id = ?')
    .run(name, company, phone, email, req.params.id);
  res.redirect('/customers');
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.redirect('/customers');
});

module.exports = router;