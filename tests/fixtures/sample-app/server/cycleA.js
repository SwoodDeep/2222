const { helperB } = require('./cycleB');

function logEvent(name) {
  return helperB(name);
}

module.exports = { logEvent };
