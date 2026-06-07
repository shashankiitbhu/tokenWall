import { DBManager, ConfigManager } from '../packages/core/dist/index.js';
import { BudgetEvaluator } from '../packages/budget-engine/dist/index.js';

async function run() {
  const db = new DBManager(':memory:');
  const config = new ConfigManager();
  
  // Create a budget
  db.db.exec(`
    INSERT INTO projects (id, name, path) VALUES ('test_proj', 'Test', '/test');
    INSERT INTO budgets (id, project_id, period, limit_amount, current_spend, hard_limit) 
    VALUES ('test_budget', 'test_proj', 'daily', 1.0, 0, 1);
    INSERT INTO sessions (id, project_id, session_budget) VALUES ('sess1', 'test_proj', 10.0);
  `);

  const evaluator = new BudgetEvaluator(db, config);
  const COST_PER_REQUEST = 0.2; // 5 requests should pass (5 * 0.2 = 1.0)
  
  const requests = Array.from({ length: 20 }).map((_, i) => async () => {
    const reqId = `req_${i}`;
    const check = evaluator.evaluate('test_proj', 'sess1', reqId, COST_PER_REQUEST);
    return check.allowed;
  });

  const results = await Promise.all(requests.map(f => f()));
  
  const passed = results.filter(r => r === true).length;
  const blocked = results.filter(r => r === false).length;

  console.log(`Passed: ${passed}, Blocked: ${blocked}`);
  
  if (passed === 5 && blocked === 15) {
    console.log('✅ Concurrency test PASSED. Atomic reservations worked.');
  } else {
    console.error('❌ Concurrency test FAILED.');
    process.exit(1);
  }
}

run().catch(console.error);
