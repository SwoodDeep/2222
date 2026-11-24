const { logEvent } = require('./cycleA');

function helperB(name) {
  if (name === 'x') return logEvent('y');
  return name;
}

module.exports = { helperB };
