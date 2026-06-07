import { DBManager, ConfigManager } from '../packages/core/dist/index.js';
import { BudgetEvaluator } from '../packages/budget-engine/dist/index.js';

async function testStaleReservationRecovery() {
  const db = new DBManager(':memory:');
  
  // Setup budget
  db.db.exec(`
    INSERT INTO projects (id, name, path) VALUES ('test_proj', 'Test', '/test');
    INSERT INTO budgets (id, project_id, period, limit_amount, current_spend, hard_limit) 
    VALUES ('test_budget', 'test_proj', 'daily', 10.0, 0, 1);
    INSERT INTO sessions (id, project_id, session_budget) VALUES ('sess1', 'test_proj', 10.0);
  `);

  // Simulate a crash mid-request by reserving but NOT reconciling
  db.reserveBudget('test_proj', 'sess1', 'req1', 5.0, 'openai', 'gpt-4');
  
  // Verify it's reserved
  const pendingBefore = db.db.prepare('SELECT SUM(amount) as p FROM reservations').get().p;
  if (pendingBefore !== 5.0) throw new Error("Reservation failed");

  // Run startup recovery
  db.reconcileStaleReservations();

  // Verify it's released and no cost incurred
  const pendingAfter = db.db.prepare('SELECT SUM(amount) as p FROM reservations').get().p;
  const spend = db.db.prepare('SELECT current_spend FROM budgets WHERE id = ?').get('test_budget').current_spend;
  
  if (pendingAfter !== null || spend !== 0) {
    throw new Error(`Recovery failed: Pending ${pendingAfter}, Spend ${spend}`);
  }
  
  console.log('✅ Stale reservation recovery works safely.');
}

async function testTransactionLockContention() {
  const db = new DBManager(':memory:');
  db.db.exec(`
    INSERT INTO projects (id, name, path) VALUES ('test_proj', 'Test', '/test');
    INSERT INTO budgets (id, project_id, period, limit_amount, current_spend, hard_limit) 
    VALUES ('test_budget', 'test_proj', 'daily', 10.0, 0, 1);
    INSERT INTO sessions (id, project_id, session_budget) VALUES ('sess1', 'test_proj', 10.0);
  `);

  // 100 parallel inserts to test lock contention
  const promises = Array.from({length: 100}).map((_, i) => async () => {
    try {
      db.reserveBudget('test_proj', 'sess1', `req${i}`, 0.05, 'openai', 'gpt-4');
      return true;
    } catch (e) {
      if (e.code === 'SQLITE_BUSY') return false;
      throw e;
    }
  });

  const results = await Promise.all(promises.map(p => p()));
  const successCount = results.filter(r => r).length;
  console.log(`✅ SQLite Transaction Contention: ${successCount}/100 passed without SQLITE_BUSY error under Promise.all`);
}

async function run() {
  await testStaleReservationRecovery();
  await testTransactionLockContention();
}

run().catch(console.error);
