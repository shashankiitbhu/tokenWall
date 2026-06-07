import { DBManager } from '../packages/core/dist/index.js';
import sqlite3 from 'better-sqlite3';
import path from 'path';

async function testSavingsEngineAndAttributions() {
  console.log('--- Testing Savings Engine and Workspace Attributions ---');
  
  // Use in-memory DB for isolated tests
  const db = new DBManager(':memory:');

  // 1. Setup mock data
  db.db.exec(`
    INSERT INTO projects (id, name, path) VALUES ('proj-a', 'Project A', '/workspaces/proj-a');
    INSERT INTO projects (id, name, path) VALUES ('proj-b', 'Project B', '/workspaces/proj-b');
    INSERT INTO sessions (id, project_id, session_budget) VALUES ('sess-1', 'proj-a', 10.0);
    INSERT INTO sessions (id, project_id, session_budget) VALUES ('sess-2', 'proj-b', 5.0);
  `);

  // 2. Simulate blocked request due to runaway loop (Saving prevention)
  const blockLoopSavingsId = 'savings-1';
  db.logSavingsEvent({
    id: blockLoopSavingsId,
    sessionId: 'sess-1',
    requestId: 'req-block-1',
    type: 'block_runaway',
    amount: 1.25,
    tokens: 250000
  });

  // 3. Simulate prompt optimization saving event
  const optimizeSavingsId = 'savings-2';
  db.logSavingsEvent({
    id: optimizeSavingsId,
    sessionId: 'sess-1',
    requestId: 'req-opt-1',
    type: 'optimize_prompt',
    amount: 0.15,
    tokens: 50000
  });

  // 4. Simulate model switch saving event
  const switchSavingsId = 'savings-3';
  db.logSavingsEvent({
    id: switchSavingsId,
    sessionId: 'sess-2',
    requestId: 'req-switch-1',
    type: 'switch_model',
    amount: 0.85,
    tokens: 0
  });

  // 5. Simulate actual spend requests
  db.db.exec(`
    INSERT INTO requests (id, session_id, provider, model, input_tokens, output_tokens, cost, status, state)
    VALUES ('req-act-1', 'sess-1', 'anthropic', 'claude-3-5-sonnet', 5000, 1000, 0.018, 'success', 'reconciled');

    INSERT INTO requests (id, session_id, provider, model, input_tokens, output_tokens, cost, status, state)
    VALUES ('req-act-2', 'sess-2', 'openai', 'gpt-4o', 2000, 500, 0.0125, 'success', 'reconciled');
  `);

  // Verify Savings Summary
  const summary = db.getSavingsSummary();
  console.log('  Aggregated Savings Summary:', summary);
  if (summary.preventedSpend !== 1.25 || summary.optimizedSavings !== 1.0 || summary.savedTokens !== 50000) {
    throw new Error(`Savings summary incorrect: ${JSON.stringify(summary)}`);
  }

  // Verify Workspace breakdown view
  const workspaces = db.getWorkspaceUsage();
  console.log('  Workspace Usage Attributions:', workspaces);
  const projA = workspaces.find(w => w.project_id === 'proj-a');
  const projB = workspaces.find(w => w.project_id === 'proj-b');
  if (projA.total_spend !== 0.018 || projB.total_spend !== 0.0125) {
    throw new Error(`Workspace breakdowns incorrect: ${JSON.stringify(workspaces)}`);
  }

  // Verify Provider breakdown view
  const providers = db.getProviderUsage();
  console.log('  Provider Usage Attributions:', providers);
  const anthropic = providers.find(p => p.provider === 'anthropic');
  const openai = providers.find(p => p.provider === 'openai');
  if (anthropic.total_spend !== 0.018 || openai.total_spend !== 0.0125) {
    throw new Error(`Provider breakdowns incorrect: ${JSON.stringify(providers)}`);
  }

  // Verify Model breakdown view
  const models = db.getModelUsage();
  console.log('  Model Usage Attributions:', models);
  const sonnet = models.find(m => m.model === 'claude-3-5-sonnet');
  const gpt4o = models.find(m => m.model === 'gpt-4o');
  if (sonnet.total_spend !== 0.018 || gpt4o.total_spend !== 0.0125) {
    throw new Error(`Model breakdowns incorrect: ${JSON.stringify(models)}`);
  }

  console.log('✅ SQLite views and Savings Engine calculations validated successfully.');
  db.close();
}

testSavingsEngineAndAttributions().catch((err) => {
  console.error('❌ Observability test failed:', err);
  process.exit(1);
});
