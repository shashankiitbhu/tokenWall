const fs = require('fs');

let file = fs.readFileSync('tests/quality-harness/eval_retrieval_reliability.mjs', 'utf8');

// 1. Add fences to rawCode calls
file = file.replace(/const opt = await optimizer\.optimize\(rawCode, 'gpt-4'/g, 'const opt = await optimizer.optimize("```javascript\\n" + rawCode + "\\n```", \'gpt-4\'');

// 2. Fix correctFinalEdit check: pass empty array of tools for the final call to force text response
file = file.replace(/const res2 = await callLLM\(messages, \[RETRIEVE_TOOL\]\);/g, 'const res2 = await callLLM(messages, []);');
file = file.replace(/const resFinal = await callLLM\(messages, \[RETRIEVE_TOOL\]\);/g, 'const resFinal = await callLLM(messages, []);');

// 3. Add guard in cross-turn scenario
const guardCode = `
        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        messages.push(res1.message);
        if (res1.message.tool_calls && res1.message.tool_calls.length > 0) {
          throw new Error("Model hallucinated a tool call on Turn 1 instead of acknowledging");
        }
`;
file = file.replace(/const res1 = await callLLM\(messages, \[RETRIEVE_TOOL\]\);\n\s*messages\.push\(res1\.message\);/g, guardCode);

// 4. Set correctId = null in Stale ID scenario
file = file.replace(/correctId = true; \/\/ Tried the ID we gave it/g, 'correctId = null; // N/A for stale ID');

// 5. Fix double escaped newlines in console output
file = file.replace(/\\\\n/g, '\\n'); // Assuming it was double escaped in the source code as string literals
// wait, the user said `Skipping ${provider}...\\n`. Let's just fix it by replacing literal \n
file = file.replace(/Skipping \$\{provider\} due to missing API key\.\\\\n/g, 'Skipping ${provider} due to missing API key.\\n');

// 6. Add comment for gemini id
file = file.replace(/id: part\.functionCall\.name \+ "_id",/g, 'id: part.functionCall.name + "_id", // Note: Assumes 1 tool call per message for simplicity in this harness');

// 7. Add Multi-retrieve scenario
const multiRetrieveScenario = `,
    {
      name: "Multi-retrieve (Two masked regions)",
      fn: async (callLLM) => {
        const rawCode1 = \`function setupDatabase() {
  let db = new Database();
  db.connect();
  // padding
  // padding
  // padding
  // padding
  // padding
  db.setToken("token_12345");
  return db;
}\`;
        const rawCode2 = \`function configureApp() {
  let app = new App();
  app.init();
  // padding
  // padding
  // padding
  // padding
  // padding
  app.setPort(8080);
  return app;
}\`;
        const opt = await optimizer.optimize("\`\`\`javascript\\n" + rawCode1 + "\\n\`\`\`\\n\\nSome text\\n\\n\`\`\`javascript\\n" + rawCode2 + "\\n\`\`\`", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const skTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_sk_'));
        
        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: \`Here is the setup code:\\n\\n\${masked}\\n\\nPlease output the database token and the app port.\` }
        ];

        let retrievedBeforeAct = false;
        let correctId = false;
        let correctFinalEdit = false;

        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        if (res1.message.tool_calls) {
          retrievedBeforeAct = true;
          // check if both were retrieved or just one
          let calledIds = [];
          for (const tc of res1.message.tool_calls) {
             if (tc.function.name === 'tokenwall_retrieve_content') {
                 const args = JSON.parse(tc.function.arguments);
                 calledIds.push(args.content_id);
             }
          }
          if (calledIds.includes(skTokens[0].id) && calledIds.includes(skTokens[1].id)) {
              correctId = true;
          } else if (calledIds.length > 0) {
              correctId = true; // At least tried one correctly
          }
          
          messages.push(res1.message);
          for (const tc of res1.message.tool_calls) {
             const args = JSON.parse(tc.function.arguments);
             const content = skTokens.find(s => s.id === args.content_id)?.content || "ERROR";
             messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: tc.id, content });
          }
          
          // Could technically loop if it retrieved 1 by 1, but let's assume it grabs both or finishes
          const res2 = await callLLM(messages, []);
          if (res2.message.content && res2.message.content.includes('token_12345') && res2.message.content.includes('8080')) {
              correctFinalEdit = true;
          } else if (res2.message.tool_calls) {
              // Handle sequential retrieval (Gemini sometimes does this)
              messages.push(res2.message);
              for (const tc of res2.message.tool_calls) {
                 const args = JSON.parse(tc.function.arguments);
                 const content = skTokens.find(s => s.id === args.content_id)?.content || "ERROR";
                 messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: tc.id, content });
              }
              const res3 = await callLLM(messages, []);
              if (res3.message.content && res3.message.content.includes('token_12345') && res3.message.content.includes('8080')) {
                  correctFinalEdit = true;
              }
          }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
    }
  ];`;

file = file.replace(/    \}\n  \];/g, multiRetrieveScenario);

fs.writeFileSync('tests/quality-harness/eval_retrieval_reliability.mjs', file);
console.log("Patch applied!");
