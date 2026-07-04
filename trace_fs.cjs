const fs = require('fs');
const path = require('path');
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function(p, options) {
  try {
    return origReadFileSync.apply(this, arguments);
  } catch (e) {
    if (e.code === 'EPERM' || e.message.includes('sandbox')) {
      console.error('BLOCKED READ:', p);
    }
    throw e;
  }
};
const origExistsSync = fs.existsSync;
fs.existsSync = function(p) {
  try {
    return origExistsSync.apply(this, arguments);
  } catch(e) {
     if (e.code === 'EPERM' || e.message.includes('sandbox')) {
      console.error('BLOCKED EXISTS:', p);
    }
    throw e;
  }
};
import('./tests/quality-harness/eval_retrieval_reliability.mjs').catch(console.error);
