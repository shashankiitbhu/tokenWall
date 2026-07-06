import { PromptOptimizer } from '../../packages/prompt-optimizer/dist/index.js';

async function runIdempotencyTest() {
  console.log("Running Idempotency Test for PromptOptimizer...");
  const optimizer = new PromptOptimizer();

  const originalMessage = `
Here is a JSON block:
\`\`\`json
{
  "large_array": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]
}
\`\`\`

And some code:
\`\`\`javascript
function calculateSum(a, b) {
  let c = a + b;
  // This is a comment that should be stripped
  return c;
}
\`\`\`

Could you please go ahead and explain how this works?
`;

  console.log("Pass 1: Optimizing original message...");
  const pass1 = await optimizer.optimize(originalMessage, 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
  
  console.log("Pass 2: Re-optimizing the already optimized message...");
  const pass2 = await optimizer.optimize(pass1.optimizedText, 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });

  if (pass1.optimizedText !== pass2.optimizedText) {
    console.error("❌ FAILED: Optimization is not idempotent!");
    console.error("--- Pass 1 Output ---");
    console.error(pass1.optimizedText);
    console.error("--- Pass 2 Output ---");
    console.error(pass2.optimizedText);
    process.exit(1);
  } else {
    console.log("✅ PASSED: Second pass resulted in the exact same output (idempotent).");
    process.exit(0);
  }
}

runIdempotencyTest().catch(err => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
