import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testIPC() {
  console.log('Starting Gateway for IPC test...');
  const gatewayPath = path.resolve(__dirname, '../apps/gateway/dist/index.js');
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '1984' }
  });

  await new Promise(r => setTimeout(r, 1500));
  
  const sqlite = (await import('better-sqlite3')).default;
  const db = new sqlite('/Users/shashankkumar/.tokenwall/database.sqlite');
  const sessionId = 'test-session-' + Math.random().toString(36).substring(7);
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Proj', '/test-' + sessionId);
  db.close();

  console.log('Starting dummy request...');
  const fetchPromise = fetch('http://localhost:1984/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'Generate a huge novel using node_modules/ file' }],
      stream: false,
      max_tokens: 50000
    })
  });

  // Give proxy time to process and queue approval
  await new Promise(r => setTimeout(r, 1000));

  console.log('Connecting WS client to approve...');
  const WebSocket = await import('ws');
  const ws = new WebSocket.default('ws://127.0.0.1:1984/ws/control');

  ws.on('open', () => {
    console.log('WS Connected');
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'approval_pending') {
      console.log('Got approval request for', msg.payload.requestId);
      ws.send(JSON.stringify({
        type: 'approval_resolved',
        payload: { requestId: msg.payload.requestId, action: 'cancel' } // We cancel to fail fast
      }));
    }
  });

  try {
    const res = await fetchPromise;
    const body = await res.json();
    if (body.error && body.error.type === 'cancelled_by_user') {
      console.log('✅ Control Plane IPC Test PASSED. Request was cancelled remotely.');
    } else {
      console.error('❌ IPC Test failed. Unexpected response:', body);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ IPC Test failed', e);
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

testIPC();
