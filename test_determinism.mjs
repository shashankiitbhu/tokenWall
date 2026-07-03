import { ContextAnalyzer } from './packages/context-engine/dist/index.js';

async function run() {
  const analyzer = new ContextAnalyzer();
  // We need to clone to prevent mutable side effects of req object across tests
  const req1 = {
    model: 'claude-3-5-sonnet',
    messages: [
      {
        role: 'user',
        content: `File: /path/to/app.js\n\`\`\`javascript\nconst a = 1;\n\`\`\``
      },
      {
        role: 'assistant',
        content: 'Ok'
      },
      {
        role: 'user',
        content: `File: /path/to/app.js\n\`\`\`javascript\nconst a = 1;\nconst b = 2;\n\`\`\``
      }
    ]
  };
  const req2 = JSON.parse(JSON.stringify(req1));

  const report1 = await analyzer.analyze(req1);
  const msgs1 = JSON.stringify(req1.messages);
  
  const report2 = await analyzer.analyze(req2);
  const msgs2 = JSON.stringify(req2.messages);

  console.log("Run 1 Output:", JSON.stringify(req1.messages, null, 2));

  if (msgs1 !== msgs2) {
    console.error("FAILED: ContextAnalyzer is not deterministic!");
    process.exit(1);
  } else {
    console.log("SUCCESS: ContextAnalyzer is perfectly deterministic across runs!");
  }
}
run();
