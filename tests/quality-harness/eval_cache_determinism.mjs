import fs from 'fs';
import assert from 'assert';
import stableStringify from 'fast-json-stable-stringify';

const topLevelOrder = {
  tools: 1,
  system: 2,
  messages: 3,
};

function stableSerialize(obj) {
  return stableStringify(obj, {
    cmp: (a, b) => {
      if (topLevelOrder[a.key] && topLevelOrder[b.key]) {
        return topLevelOrder[a.key] - topLevelOrder[b.key];
      }
      if (topLevelOrder[a.key]) return -1;
      if (topLevelOrder[b.key]) return 1;
      return a.key > b.key ? 1 : -1;
    }
  });
}

function jumbleKeys(obj) {
  if (Array.isArray(obj)) {
    return obj.map(jumbleKeys);
  } else if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const newObj = {};
    for (const key of keys) {
      newObj[key] = jumbleKeys(obj[key]);
    }
    return newObj;
  }
  return obj;
}

try {
  const payloadPath = '/Users/shashankkumar/.tokenwall/logs/latest_optimized_request.json';
  const rawPayload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  
  const jumbled1 = jumbleKeys(rawPayload);
  const jumbled2 = jumbleKeys(rawPayload);
  
  const native1 = JSON.stringify(jumbled1);
  const native2 = JSON.stringify(jumbled2);
  
  if (native1 !== native2) {
    console.log("Native JSON.stringify: Key entropy detected (expected variance).");
  } else {
    console.log("Native JSON.stringify: Coincidentally identical (small payload).");
  }
  
  const stable1 = stableSerialize(jumbled1);
  const stable2 = stableSerialize(jumbled2);
  
  assert.equal(stable1, stable2, 'Stable serialization failed to produce identical byte sequences!');
  console.log("Cache Determinism Test Passed! Byte-equality guaranteed across re-serializations.");
} catch (e) {
  console.error("Test failed:", e);
  process.exit(1);
}
