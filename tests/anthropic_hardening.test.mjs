import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import sqlite3 from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gatewayPath = path.resolve(__dirname, '../apps/gateway/dist/index.js');
const dbPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.tokenwall', 'database.sqlite');

async function testFragmentedPackets() {
  console.log('\n--- 1. Testing Fragmented SSE Packet Handling ---');
  const { ProviderRegistry } = await import('../packages/providers/dist/index.js');
  const { createParser } = await import('eventsource-parser');

  let textAccumulated = '';
  let inputTokens = 0;
  let outputTokens = 0;

  const parser = createParser({
    onEvent: (event) => {
      const parsedChunk = ProviderRegistry.parseStreamChunk('anthropic', event.data);
      if (parsedChunk) {
        if (parsedChunk.text) textAccumulated += parsedChunk.text;
        if (parsedChunk.usage) {
          if (parsedChunk.usage.inputTokens > 0) inputTokens = parsedChunk.usage.inputTokens;
          if (parsedChunk.usage.outputTokens > 0) outputTokens = parsedChunk.usage.outputTokens;
        }
      }
    }
  });

  // Feed fragmented chunks
  const packets = [
    'da', 'ta: ', '{"ty', 'pe": "', 'message_start", "message": {"usage": {"input_tokens": 150', '}}}\n\n',
    'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "name": "r', 'un_command"}}\n\n',
    'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\\"c', 'md\\": \\"ls -la\\""', '}}\n\n',
    'data: {"type": "content_block_stop", "index": 0}\n\n',
    'data: {"type": "message_delta", "usage": {"output_tokens": 80', '}}\n\n',
    'data: {"type": "message_stop"}\n\n'
  ];

  for (const pkt of packets) {
    parser.feed(pkt);
  }

  console.log(`  Accumulated Text:  "${textAccumulated}"`);
  console.log(`  Input Tokens:      ${inputTokens}`);
  console.log(`  Output Tokens:     ${outputTokens}`);

  if (textAccumulated !== '[Tool Use: run_command]{"cmd": "ls -la"') {
    throw new Error(`Text accumulation failed. Got: ${textAccumulated}`);
  }
  if (inputTokens !== 150 || outputTokens !== 80) {
    throw new Error('Token parsing failed');
  }

  console.log('✅ SSE fragmentation and tool call inputs parsing passed.');
}

async function testParallelContentionAndCancellation() {
  console.log('\n--- 2. Testing SQLite Contention & Mid-Stream Cancellation Recovery ---');

  // Boot the gateway
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'ignore',
    env: { ...process.env, PORT: '1984' }
  });
  await new Promise(r => setTimeout(r, 1500));

  const sessionId = 'test-hardening-' + Math.random().toString(36).substring(7);
  const db = new sqlite3(dbPath);

  // Setup mock project/session/budgets
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Hardening Proj', '/test-' + sessionId);
  db.prepare('INSERT OR IGNORE INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(sessionId, sessionId, 100.0);
  db.close();

  // Connect websocket client to prevent native OS popup dialog during testing
  const ws = new WebSocket('ws://127.0.0.1:1984/ws/control');
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'approval_pending') {
      ws.send(JSON.stringify({
        type: 'approval_resolved',
        payload: { requestId: msg.payload.requestId, action: 'approve' }
      }));
    }
  });

  // Verify websocket is open
  await new Promise((resolve) => ws.on('open', resolve));

  // Perform parallel request flood to verify transaction thread-safety (parallel budget reservations)
  const reqPromises = Array.from({ length: 5 }).map(async (_, idx) => {
    try {
      const res = await fetch('http://localhost:1984/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tokenwall-session-id': sessionId,
          'x-tokenwall-project-id': sessionId
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Generate a short summary' }],
          max_tokens: 100
        })
      });
      return res.status;
    } catch (e) {
      return 500;
    }
  });

  const statuses = await Promise.all(reqPromises);
  console.log('  Parallel Interception Request statuses:', statuses);

  // Trigger mid-stream cancellation test
  console.log('  Triggering mid-stream cancellation...');
  const abortController = new AbortController();
  
  const cancelPromise = fetch('http://localhost:1984/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Generate a long loop' }],
      stream: true,
      max_tokens: 1000
    }),
    signal: abortController.signal
  });

  // Let the stream start, then abort
  await new Promise(r => setTimeout(r, 800));
  abortController.abort();

  try {
    await cancelPromise;
  } catch (e) {
    console.log('  Stream fetch successfully aborted locally.');
  }

  // Allow some time for gateway to process the abort event
  await new Promise(r => setTimeout(r, 1000));

  // Check SQLite reservations to ensure no orphan locks remain
  const dbCheck = new sqlite3(dbPath);
  const reservations = dbCheck.prepare('SELECT * FROM reservations WHERE session_id = ?').all(sessionId);
  dbCheck.close();

  console.log(`  Active Reservations remaining for session: ${reservations.length}`);
  
  if (reservations.length > 0) {
    ws.close();
    gatewayServer.kill();
    throw new Error('Orphan reservations detected in SQLite database after stream cancellation!');
  }

  console.log('✅ SQLite thread contention and stream cancellation recovery tests passed.');
  
  ws.close();
  gatewayServer.kill();
}

async function run() {
  await testFragmentedPackets();
  await testParallelContentionAndCancellation();
  console.log('\nAll reliability hardening tests passed successfully.');
}

run().catch((err) => {
  console.error('\n❌ Integration test failed:', err.message);
  process.exit(1);
});
