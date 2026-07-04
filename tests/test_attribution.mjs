import { TokenAttributionAnalyzer } from '../packages/estimators/dist/attribution.js';

const mockReq = {
  model: 'claude-opus-4-8',
  toolsSchemaText: '[{"name": "read_file", "description": "reads files"}]',
  messages: [
    {
      role: 'system',
      content: 'You are an agent. Here are your skills: [...]'
    },
    {
      role: 'user',
      content: `Hello! Please fix my code.
      
<file_content path="src/auth.ts">
function auth() {
  console.log("Checking auth");
}
</file_content>

\`\`\`json
{
  "dependencies": {
    "foo": "1.0.0"
  }
}
\`\`\`

Here is the error log:
Error: Failed to auth
  at /app/src/auth.ts:2:3
  at processTicks (/app/node_modules/timers.js:1:2)
`
    }
  ]
};

const result = TokenAttributionAnalyzer.analyze(mockReq);
console.log(JSON.stringify(result, null, 2));
