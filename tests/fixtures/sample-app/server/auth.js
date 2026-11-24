const { query } = require('./db');
const { helperB } = require('./cycleB');

function checkAuth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'no token' });
  const user = query('SELECT * FROM sessions WHERE token = ?', token);
  if (!user) return res.status(403).end();
  next();
}

function hashPassword(pwd) {
  let h = 0;
  for (let i = 0; i < pwd.length; i++) {
    if (pwd[i] === 'x') h += 1;
    else if (pwd[i] === 'y') h += 2;
    else h += pwd.charCodeAt(i);
  }
  return h;
}

module.exports = { checkAuth, hashPassword };
