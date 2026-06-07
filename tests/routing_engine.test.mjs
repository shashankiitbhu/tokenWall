import { ModelRouter } from '../packages/routing-engine/dist/index.js';

async function run() {
  console.log('--- Testing Routing Engine ---');
  
  const router = new ModelRouter();
  
  // Test 1: Low complexity task with premium model
  const req1 = {
    provider: 'anthropic',
    model: 'claude-3-opus',
    messages: [{ role: 'user', content: 'fix the typo in this file' }],
    stream: false,
    toolsAttached: false
  };
  
  const res1 = router.generateRoutingOptions(req1, 50, 50);
  console.log('Test 1: Low complexity task (claude-3-opus)');
  console.log('  Complexity:', res1.complexity);
  console.log('  Should Route:', res1.shouldRoute);
  console.log('  Original Cost:', res1.originalEstimatedCost);
  console.log('  Alternatives:', res1.alternatives.map(a => `${a.model} ($${a.estimatedCost}, Quality: ${a.qualityLevel}, Savings: ${a.savingsPercentage}%)`).join(', '));
  if (res1.complexity !== 'low' || !res1.shouldRoute || res1.alternatives.length === 0) {
    console.error('Test 1 Failed');
    process.exit(1);
  }
  console.log('Test 1 Passed\n');

  // Test 2: High complexity task
  const req2 = {
    provider: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'refactor this entire repository and optimize queries' }],
    stream: false,
    toolsAttached: true
  };
  
  const res2 = router.generateRoutingOptions(req2, 2000, 1500);
  console.log('Test 2: High complexity task (gpt-4o)');
  console.log('  Complexity:', res2.complexity);
  console.log('  Should Route:', res2.shouldRoute);
  console.log('  Alternatives:', res2.alternatives.map(a => a.model).join(', '));
  if (res2.complexity !== 'high' || res2.shouldRoute) {
    console.error('Test 2 Failed');
    process.exit(1);
  }
  console.log('Test 2 Passed\n');
  
  console.log('All routing engine tests passed successfully.');
}

run().catch(console.error);
