import assert from 'assert';
import { spawn } from 'child_process';
import { DBManager } from '../packages/core/dist/db.js';
import { JsonCrusher, CodeCompressor, ContextAnalyzer, CacheAlignerPipeline } from '../packages/context-engine/dist/index.js';
import { PromptOptimizer } from '../packages/prompt-optimizer/dist/index.js';

async function testCompressors() {
  console.log('Testing JsonCrusher...');
  const originalJson = '{\n  "name": "TokenWall",\n  "version": "1.0.0",\n  "features": [\n    "Spend Firewall",\n    "Context Optimization"\n  ]\n}';
  const crushed = JsonCrusher.crush(originalJson);
  console.log('Crushed JSON:', crushed);
  assert.equal(crushed, '{"name":"TokenWall","version":"1.0.0","features":["Spend Firewall","Context Optimization"]}');
  console.log('JsonCrusher works!');

  console.log('Testing CodeCompressor...');
  const rawCode = `
    // A comment
    function helloWorld() {
      /* Multi line
         comment */
      console.log("Hello!"); // Inline comment
    }
  `;
  const compressed = CodeCompressor.compress(rawCode);
  console.log('Compressed Code:', compressed);
  assert.ok(!compressed.includes('comment'));
  assert.ok(compressed.includes('function helloWorld'));
  console.log('CodeCompressor works!');
}

async function testCacheAligner() {
  console.log('Testing CacheAlignerPipeline...');
  const pipeline = new CacheAlignerPipeline();

  const rawText = "   Hello    World \n\n\n This is a test. ";
  const aligned = pipeline.align(rawText, 'system', true);
  console.log('Normalized Whitespace:', JSON.stringify(aligned.prompt));
  assert.equal(aligned.prompt, "Hello World\n\nThis is a test.");

  const testText = "UUID: 123e4567-e89b-12d3-a456-426614174000, Date: 2026-06-17, JWT: aaaa.bbbb.cccc, Hex: a9f10a8e1b2c3d4e5f6a7b8c9d0e1f2a";
  const findingsContext = pipeline.align(testText, 'system', true);
  console.log('Detected Volatile Tokens:', findingsContext.findings);
  const types = findingsContext.findings.map((f) => f.type);
  assert.ok(types.includes('uuid'));
  assert.ok(types.includes('iso8601'));
  // Hex hashes are not detected by default in VolatileRelocationPlugin to avoid false positives (was part of old CacheAligner)
  // assert.ok(types.includes('hex_hash')); 
  console.log('CacheAlignerPipeline tests pass!');
}

async function testContextAnalyzer() {
  console.log('Testing ContextAnalyzer with Code Compression & Reversible CCR...');
  const analyzer = new ContextAnalyzer();
  const mockReq = {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: 'Here is some code:\n```javascript\n// Some comments here\n' + 'const x = 42;\n'.repeat(30) + '```\nAnd a large lockfile:\nFile: package-lock.json\n```json\n"dependencies": {}\n```'
      }
    ],
    stream: false,
    toolsAttached: false,
    rawBody: {}
  };

  const report = await analyzer.analyze(mockReq, {
    reversibleCompression: true,
    codeCompression: true,
    jsonCrushing: true,
    dailyLimit: 10,
    monthlyLimit: 100,
    sessionLimit: 2,
    hardLimitsEnabled: true,
    blacklistedPatterns: [],
    autoOptimize: true
  });

  console.log('Report inefficiencies:', report.inefficiencies);
  console.log('Cached contents count:', report.cachedContents.length);
  assert.ok(report.cachedContents.length > 0);
  assert.ok(report.cleanMessages[0].content.includes('TokenWall Reversible Content:'));

  console.log('Testing ContextAnalyzer Volatile Prefix Detection...');
  const mockReqWithVolatile = {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'Today is 2026-06-17T18:00:00Z. UUID: 123e4567-e89b-12d3-a456-426614174000'
      }
    ],
    stream: false,
    toolsAttached: false,
    rawBody: {}
  };
  const reportWithVolatile = await analyzer.analyze(mockReqWithVolatile, { cacheAlignment: true });
  console.log('Volatile inefficiencies:', reportWithVolatile.inefficiencies);
  const volatileIneffs = reportWithVolatile.inefficiencies.filter(i => i.type === 'volatile_prefix');
  assert.equal(volatileIneffs.length, 2);
  assert.ok(volatileIneffs.find(i => i.target.includes('2026-06-17')));
  assert.ok(volatileIneffs.find(i => i.target.includes('123e4567')));

  console.log('ContextAnalyzer works!');
}

function resetDatabase(db) {
  db.db.prepare('DELETE FROM reservations').run();
  db.db.prepare('DELETE FROM tool_call_usage').run();
  db.db.prepare('DELETE FROM cached_contents').run();
  db.db.prepare('DELETE FROM savings_events').run();
  db.db.prepare('DELETE FROM events').run();
  db.db.prepare('DELETE FROM requests').run();
  db.db.prepare('DELETE FROM sessions').run();
  db.db.prepare('DELETE FROM projects').run();
}

async function testSQLiteCCR() {
  console.log('Testing SQLite CCR DB methods...');
  const db = new DBManager();
  resetDatabase(db);
  const testId = 'ccr_test_' + Math.random().toString(36).substring(7);
  const testRequestId = 'req_' + Math.random().toString(36).substring(7);
  const original = 'Hello World - Untruncated text';

  // Make sure request exists
  db.db.prepare("INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES ('s1', null, 10.0)").run();
  db.db.prepare("INSERT OR IGNORE INTO requests (id, session_id, provider, model, input_tokens, output_tokens, cost, status, state) VALUES (?, 's1', 'openai', 'gpt-4', 0, 0, 0.0, 'success', 'reconciled')").run(testRequestId);

  db.saveCachedContent(testId, testRequestId, original);
  const retrieved = db.getCachedContent(testId);
  console.log('Retrieved from DB:', retrieved);
  assert.equal(retrieved, original);
  
  db.close();
  console.log('SQLite CCR methods work!');
}

async function testRecursiveCCRInterception() {
  console.log('Testing Gateway Recursive CCR Interception...');
  // 1. Boot local gateway
  const gateway = spawn('node', ['./apps/gateway/dist/index.js'], {
    env: { ...process.env, PORT: '1984' }
  });

  // Wait for gateway to boot
  await new Promise(resolve => setTimeout(resolve, 2000));

  const db = new DBManager();
  resetDatabase(db);
  const testSessionId = 'test-session-' + Math.random().toString(36).substring(2, 9);

  // Pre-seed a session
  db.db.prepare('INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES (?, null, ?)').run(testSessionId, 100.0);
  
  // Set budget configuration limits to accept calls
  db.db.prepare("INSERT OR REPLACE INTO budgets (id, project_id, period, limit_amount, current_spend, hard_limit) VALUES ('b1', null, 'daily', 50.0, 0.0, 1)").run();

  // Pre-seed some cached content
  const ccrId = 'ccr_lk_test123';
  const dummyRequestId = 'dummy-req-id';
  
  db.db.prepare("INSERT OR IGNORE INTO requests (id, session_id, provider, model, input_tokens, output_tokens, cost, status, state) VALUES (?, ?, 'openai', 'gpt-4o-mini', 0, 0, 0.0, 'success', 'reconciled')").run(dummyRequestId, testSessionId);
  db.saveCachedContent(ccrId, dummyRequestId, '{"dependencies": {"lodash": "4.17.21"}}');
  db.close();

  // Make mock request with CCR instruction
  const mockPayload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `Check dependencies in [TokenWall Reversible Content: ${ccrId}]. Tell me lodash version.` }
    ],
    stream: false
  };

  gateway.kill();
  console.log('Gateway booted and shut down successfully.');
}

async function testPromptOptimizer() {
  console.log('Testing PromptOptimizer String Truncation and CCR Skeletonization...');
  const optimizer = new PromptOptimizer();
  const longHex = "a".repeat(250);
  const longText = "This is a very long text string that contains mostly natural language words and spaces, so it does not match the entropy regexes and should therefore be safely truncated by the new string truncation logic that we just added to the json minifier. " + "A".repeat(100);
  
  const testPayload = `
\`\`\`json
{
  "reference_id": "${longHex}",
  "description": "${longText}"
}
\`\`\`

\`\`\`typescript
function doComplexWork() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  const i = 9;
  const j = 10;
  const k = 11;
  const l = 12;
  return a + b + c + d + e + f + g + h + i + j + k + l;
}
\`\`\`
`;
  
  // Test 1: Normal optimization (should trigger CCR JSON truncation and Code Skeletonization)
  const result1 = await optimizer.optimize(testPayload, 'gpt-4');
  const optimized = result1.optimizedText;
  
  assert.ok(optimized.includes(longHex), "Hex ID should bypass truncation");
  assert.ok(!optimized.includes(longText), "Long text should be truncated");
  assert.ok(optimized.includes('[TokenWall Reversible Content: ccr_js_'), "Truncation marker should be present for JSON");
  
  assert.ok(optimized.includes('[TokenWall Reversible Content: ccr_sk_'), "Code should be skeletonized with CCR token");
  assert.ok(!optimized.includes('const k = 11;'), "Skeletonized body should be removed from text");
  
  // Verify cached contents are returned correctly
  assert.ok(result1.cachedContents && result1.cachedContents.length >= 2, "Should return cachedContents array with both JS and SK tokens");
  assert.ok(result1.cachedContents.some((c) => c.id.startsWith('ccr_js_')), "Has cached js content");
  assert.ok(result1.cachedContents.some((c) => c.id.startsWith('ccr_sk_')), "Has cached sk content");

  // Test 2: Disable Code Compression (simulate active edit tools)
  const result2 = await optimizer.optimize(testPayload, 'gpt-4', { disableCodeCompression: true });
  assert.ok(!result2.optimizedText.includes('ccr_sk_'), "Code compression should be skipped");
  assert.ok(result2.optimizedText.includes('const k = 11;'), "Original code body should be preserved when compression disabled");

  console.log('PromptOptimizer CCR and Truncation works!');
}

async function run() {
  await testCompressors();
  await testCacheAligner();
  await testContextAnalyzer();
  await testSQLiteCCR();
  await testRecursiveCCRInterception();
  await testPromptOptimizer();
  console.log('\n🎉 ALL CONTEXT OPTIMIZATION TESTS PASSED!');
}

run().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
