const express = require('express');
const { query } = require('./db');
const { checkAuth } = require('./auth');

const app = express();
app.use(express.json());

app.get('/api/users', (req, res) => {
  const rows = query('SELECT * FROM users');
  res.json(rows);
});

app.post('/api/users', checkAuth, (req, res) => {
  const row = query('INSERT INTO users (name) VALUES (?)', req.body.name);
  res.json(row);
});

app.get('/api/users/:id', (req, res) => {
  const row = query('SELECT * FROM users WHERE id = ?', req.params.id);
  res.json(row);
});

app.listen(3000, () => console.log('listening on 3000'));
