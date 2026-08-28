const express = require('express');
const router = express.Router();

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// Public landing page. If already logged in, fall through (next()) to the
// dashboard route mounted right after this router in server.js — so '/'
// always shows the right thing depending on session state, with no
// duplicate route path needed.
router.get('/', (req, res, next) => {
  if (req.session && req.session.loggedIn) return next();
  res.redirect('/login');
});

router.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    req.session.username = username;
    return res.redirect('/');
  }
  res.render('login', { error: 'Invalid username or password' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;