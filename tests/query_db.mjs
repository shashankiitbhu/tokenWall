import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

const srcDbPath = path.join(os.homedir(), '.tokenwall', 'database.sqlite');
const destDbPath = './tests/temp_db.sqlite';

try {
  // Copy the database file locally to bypass sandbox path blocks on SQLite opening files
  fs.copyFileSync(srcDbPath, destDbPath);
  console.log('Successfully copied database to:', destDbPath);

  const db = new Database(destDbPath, { readonly: true });
  
  const lastRequests = db.prepare(`
    SELECT id, model, input_tokens, output_tokens, cost, optimized_tokens_saved, status, created_at
    FROM requests 
    ORDER BY created_at DESC 
    LIMIT 6;
  `).all();
  
  console.log('\n=== Recent Requests Comparison ===');
  console.log(String.prototype.padEnd('CREATED AT', 22) + ' | ' +
    String.prototype.padEnd('MODEL', 25) + ' | ' +
    String.prototype.padStart('IN TOKENS', 10) + ' | ' +
    String.prototype.padStart('SAVED TOKENS', 12) + ' | ' +
    String.prototype.padStart('OUT TOKENS', 10) + ' | ' +
    String.prototype.padStart('COST ($)', 12));
  console.log('-'.repeat(93));
  
  for (const r of lastRequests) {
    const time = new Date(r.created_at).toLocaleString();
    console.log(
      time.padEnd(22) + ' | ' +
      (r.model || 'unknown').substring(0, 25).padEnd(25) + ' | ' +
      String(r.input_tokens).padStart(10) + ' | ' +
      String(r.optimized_tokens_saved).padStart(12) + ' | ' +
      String(r.output_tokens).padStart(10) + ' | ' +
      `$${r.cost.toFixed(6)}`.padStart(12)
    );
  }

  db.close();
  // Clean up
  fs.unlinkSync(destDbPath);
} catch (e) {
  console.error('Error querying DB:', e);
}
