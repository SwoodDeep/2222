const { logEvent } = require('./cycleA');

function query(sql, params) {
  // имитация обращения к базе данных
  console.log('SQL:', sql, params);
  return [];
}

function connect() {
  logEvent('db-connect');
}

module.exports = { query, connect };
