import { spawn } from 'child_process';
import { DBManager } from './packages/core/dist/db.js';

async function runTest() {
  console.log('🚀 Starting TokenWall Interception Test...');

  // 1. Boot local gateway
  const gateway = spawn('node', ['./apps/gateway/dist/index.js'], {
    env: { ...process.env, PORT: '1984' }
  });

  // Wait for gateway to boot
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 2. Clear old test session metrics in sqlite
  const db = new DBManager();
  const testSessionId = 'test-session-' + Math.random().toString(36).substring(2, 9);
  
  // Set budget configuration limits to very small to test budget alerts
  db.db.prepare('DELETE FROM requests').run();
  db.db.prepare('DELETE FROM sessions').run();
  
  console.log(`Created test session: ${testSessionId}`);

  // 3. Make mock OpenAI API call to local gateway proxy
  const mockPayload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Could you please go ahead and help me write a quick function to sort list in JS? Please make sure to write tests and handle error cases.' }
    ],
    stream: false
  };

  console.log('Sending mock request to TokenWall gateway...');
  try {
    const res = await fetch('http://127.0.0.1:1984/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tokenwall-session-id': testSessionId,
        'authorization': 'Bearer mock-key' // Simulated authorization key
      },
      body: JSON.stringify(mockPayload)
    });

    console.log(`Response Status: ${res.status}`);
    const data = await res.json();
    console.log('Response Payload:', JSON.stringify(data, null, 2));

    // Verify telemetry db entries
    const requestLogs = db.db.prepare('SELECT * FROM requests').all();
    console.log('\n--- Telemetry Logs in SQLite ---');
    console.log(requestLogs);

    if (requestLogs.length > 0) {
      console.log('\n✅ TEST PASSED: Request successfully intercepted and logged in database!');
    } else {
      console.log('\n❌ TEST FAILED: Request not logged.');
    }
  } catch (err) {
    console.error('Error making fetch request:', err);
  } finally {
    // Shutdown gateway
    gateway.kill();
    db.close();
    process.exit(0);
  }
}

runTest();
