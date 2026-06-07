import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { ReplayEngine } from './engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runFixture(engine, gatewayServer, db, fixtureName, endpoint, payloadTemplate) {
  const fixture = await engine.loadFixture(fixtureName);
  const sessionId = `test-run-${Math.random().toString(36).substring(7)}`;
  
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Proj', '/test-' + sessionId);
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(sessionId, sessionId, 100.0);

  console.log(`\n▶️  Running fixture: ${fixtureName} against endpoint: ${endpoint}`);

  const fetchPromise = fetch(`http://localhost:1984${endpoint}`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify(payloadTemplate)
  });

  try {
    const res = await fetchPromise;
    // We stream it out just to consume it
    const text = await res.text();
    console.log(`[Client] Received response. Length: ${text.length} chars.`);
  } catch (e) {
    console.log(`[Client] Request interrupted or failed (expected if disconnect fixture):`, e.message);
  }

  // Allow gateway background reconciliation to finish
  await new Promise(r => setTimeout(r, 1000));

  // Query DB to verify
  const reqStmt = db.prepare('SELECT input_tokens, output_tokens, state, status FROM requests WHERE session_id = ?').get(sessionId);
  if (!reqStmt) {
    throw new Error(`Fixture ${fixtureName}: No request found in database!`);
  }

  const { input_tokens, output_tokens, state, status } = reqStmt;
  console.log(`[Assertions] Db tokens: Input=${input_tokens}, Output=${output_tokens}`);
  console.log(`[Assertions] Db state: ${state}, status: ${status}`);

  if (input_tokens !== fixture.expectedInputTokens) {
    throw new Error(`Fixture ${fixtureName}: Input token mismatch. Expected ${fixture.expectedInputTokens}, got ${input_tokens}`);
  }
  if (output_tokens !== fixture.expectedOutputTokens) {
    throw new Error(`Fixture ${fixtureName}: Output token mismatch. Expected ${fixture.expectedOutputTokens}, got ${output_tokens}`);
  }

  // Check no leaked reservations
  const pending = db.prepare('SELECT SUM(amount) as p FROM reservations WHERE session_id = ?').get(sessionId).p;
  if (pending > 0) {
    throw new Error(`Fixture ${fixtureName}: Leaked reservation of $${pending} detected!`);
  }

  console.log(`✅ Fixture ${fixtureName} PASSED.`);
}

async function run() {
  console.log('--- Starting Multi-Provider Replay Validation Harness ---\n');

  const engine = new ReplayEngine();
  await engine.start(2024);

  const gatewayPath = path.resolve(__dirname, '../../apps/gateway/dist/index.js');
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'inherit',
    env: { 
      ...process.env, 
      PORT: '1984',
      TOKENWALL_HEADLESS: 'true',
      OPENAI_UPSTREAM_URL: 'http://localhost:2024/v1/chat/completions',
      ANTHROPIC_UPSTREAM_URL: 'http://localhost:2024/v1/messages',
      GEMINI_UPSTREAM_URL: 'http://localhost:2024'
    }
  });

  await new Promise(r => setTimeout(r, 2000));

  const sqlite = (await import('better-sqlite3')).default;
  const db = new sqlite('/Users/shashankkumar/.tokenwall/database.sqlite');

  try {
    await runFixture(engine, gatewayServer, db, 'anthropic-interrupted', '/v1/messages', {
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      max_tokens: 1000
    });

    await runFixture(engine, gatewayServer, db, 'openai-tools-stream', '/v1/chat/completions', {
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      max_tokens: 1000
    });

    await runFixture(engine, gatewayServer, db, 'gemini-safety-block', '/v1/models/gemini-1.5-flash:generateContent?stream=true', {
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      generationConfig: { maxOutputTokens: 1000 }
    });

    console.log('\n🎉 All Multi-Provider Replay Assertions PASSED.');
  } catch (err) {
    console.error('\n❌ Replay Validation FAILED:', err);
    process.exit(1);
  } finally {
    db.close();
    gatewayServer.kill();
    await engine.stop();
  }
}

run().catch(console.error);
