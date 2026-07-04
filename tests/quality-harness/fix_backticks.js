const fs = require('fs');
let f = fs.readFileSync('tests/quality-harness/eval_retrieval_reliability.mjs', 'utf8');
f = f.split('\\`').join('`');
fs.writeFileSync('tests/quality-harness/eval_retrieval_reliability.mjs', f);
