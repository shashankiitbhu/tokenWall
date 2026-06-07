import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testAnthropic() {
  console.log('--- Testing Anthropic Integration ---');
  const gatewayPath = path.resolve(__dirname, '../apps/gateway/dist/index.js');
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'ignore',
    env: { ...process.env, PORT: '1984' }
  });

  await new Promise(r => setTimeout(r, 1500));
  
  const sqlite = (await import('better-sqlite3')).default;
  const db = new sqlite('/Users/shashankkumar/.tokenwall/database.sqlite');
  const sessionId = 'test-anthropic-' + Math.random().toString(36).substring(7);
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Proj', '/test-' + sessionId);
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(sessionId, sessionId, 100.0);
  db.close();

  const fetchPromise = fetch('http://localhost:1984/v1/messages', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify({
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'Generate a long response' }],
      max_tokens: 1000
    })
  });

  await new Promise(r => setTimeout(r, 1000));

  const WebSocket = await import('ws');
  const ws = new WebSocket.default('ws://127.0.0.1:1984/ws/control');

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'approval_pending') {
      ws.send(JSON.stringify({
        type: 'approval_resolved',
        payload: { requestId: msg.payload.requestId, action: 'cancel' }
      }));
    }
  });

  try {
    const res = await fetchPromise;
    const body = await res.json();
    if (body.error && body.error.type === 'cancelled_by_user') {
      console.log('✅ Anthropic IPC Test PASSED. Request was intercepted and cancelled remotely.');
    } else {
      console.error('❌ Anthropic IPC Test failed. Unexpected response:', body);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Anthropic IPC Test failed', e);
  } finally {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.close();
      } else if (ws.readyState === 0) { // CONNECTING
        ws.on('open', () => ws.close());
        ws.on('error', () => {}); // ignore errors during abort
      }
    } catch (e) {}
    gatewayServer.kill();
  }
}

async function testGemini() {
  console.log('--- Testing Gemini Integration ---');
  const gatewayPath = path.resolve(__dirname, '../apps/gateway/dist/index.js');
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'ignore',
    env: { ...process.env, PORT: '1984' }
  });

  await new Promise(r => setTimeout(r, 1500));
  
  const sqlite = (await import('better-sqlite3')).default;
  const db = new sqlite('/Users/shashankkumar/.tokenwall/database.sqlite');
  const sessionId = 'test-gemini-' + Math.random().toString(36).substring(7);
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Proj', '/test-' + sessionId);
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(sessionId, sessionId, 100.0);
  db.close();

  const fetchPromise = fetch('http://localhost:1984/v1/models/gemini-1.5-pro:generateContent', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Write a novel' }] }],
      generationConfig: { maxOutputTokens: 40000 }
    })
  });

  await new Promise(r => setTimeout(r, 1000));

  const WebSocket = await import('ws');
  const ws = new WebSocket.default('ws://127.0.0.1:1984/ws/control');

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'approval_pending') {
      ws.send(JSON.stringify({
        type: 'approval_resolved',
        payload: { requestId: msg.payload.requestId, action: 'cancel' }
      }));
    }
  });

  try {
    const res = await fetchPromise;
    const body = await res.json();
    if (body.error && body.error.type === 'cancelled_by_user') {
      console.log('✅ Gemini IPC Test PASSED. Request was intercepted and cancelled remotely.');
    } else {
      console.error('❌ Gemini IPC Test failed. Unexpected response:', body);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Gemini IPC Test failed', e);
  } finally {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.close();
      } else if (ws.readyState === 0) { // CONNECTING
        ws.on('open', () => ws.close());
        ws.on('error', () => {}); // ignore errors during abort
      }
    } catch (e) {}
    gatewayServer.kill();
  }
}

async function run() {
  await testAnthropic();
  await testGemini();
  console.log('\nAll integration tests passed.');
}

run().catch(console.error);
