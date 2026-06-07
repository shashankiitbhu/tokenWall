import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testHeadless() {
  console.log('Starting Gateway for Headless test...');
  const gatewayPath = path.resolve(__dirname, '../apps/gateway/dist/index.js');
  const gatewayServer = spawn('node', [gatewayPath], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '1984', TOKENWALL_HEADLESS: 'true' } // Force headless
  });

  await new Promise(r => setTimeout(r, 1500));
  
  const sqlite = (await import('better-sqlite3')).default;
  const db = new sqlite('/Users/shashankkumar/.tokenwall/database.sqlite');
  const sessionId = 'test-session-' + Math.random().toString(36).substring(7);
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(sessionId, 'Test Proj', '/test-' + sessionId);
  db.close();

  console.log('Sending expensive request (should be auto-denied)...');
  const res = await fetch('http://localhost:1984/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'x-tokenwall-session-id': sessionId,
      'x-tokenwall-project-id': sessionId
    },
    body: JSON.stringify({
      model: 'gpt-4-turbo',
      messages: [{ role: 'user', content: 'Generate 1000 pages of text using node_modules/ file' }], 
      stream: false,
      max_tokens: 50000
    })
  });

  const body = await res.json();
  if (body.error && body.error.type === 'cancelled_by_user') {
    // Wait, in my index.ts logic, headless cancel sends `cancelled_by_user`. Let's check it.
    console.log('✅ Headless Policy Test PASSED. Expensive request was automatically denied.');
  } else {
    console.error('❌ Headless Test failed. Unexpected response:', body);
    process.exit(1);
  }

  gatewayServer.kill();
}

testHeadless();
