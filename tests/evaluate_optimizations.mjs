import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { countTokens } from '../packages/estimators/dist/index.js';
import { PromptOptimizer, ToolRouter, ToolSchemaOptimizer, ToolPayloadCrusher } from '../packages/prompt-optimizer/dist/index.js';
import { ContextAnalyzer } from '../packages/context-engine/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- MOCK DATA ---

const conversationalBoilerplate = "Could you please go ahead and check the file index.ts, and then please write a highly detailed, clean, and production-grade function that handles user authentication using JWT tokens? Make sure to write tests and handle error cases, kindly help me with this. Thank you so much!";

const mockServerLog = `
2026-06-17T18:00:01Z [INFO] Initializing server on port 8080
2026-06-17T18:00:02Z [DEBUG] Loaded 453 configurations from database
2026-06-17T18:00:03Z [TRACE] Request 1234: Incoming payload { id: 1, action: "ping" }
2026-06-17T18:00:04Z [INFO] Handled Request 1234 successfully
2026-06-17T18:00:05Z [DEBUG] Connection pool size: 5, active: 1
2026-06-17T18:00:06Z [TRACE] Request 1235: Incoming payload { id: 2, action: "run" }
2026-06-17T18:00:07Z [ERROR] Failed to run job! FATAL: NullPointerException at Worker.run(Worker.java:42)
2026-06-17T18:00:08Z [INFO] Shutting down connection pool
2026-06-17T18:00:09Z [DEBUG] Connection pool destroyed
2026-06-17T18:00:10Z [TRACE] System exit code 1
2026-06-17T18:00:11Z [INFO] Initializing backup server on port 8081
2026-06-17T18:00:12Z [DEBUG] Loaded 453 configurations from database
2026-06-17T18:00:13Z [TRACE] Request 1236: Incoming payload { id: 3, action: "ping" }
2026-06-17T18:00:14Z [INFO] Handled Request 1236 successfully
2026-06-17T18:00:15Z [DEBUG] Connection pool size: 5, active: 1
2026-06-17T18:00:16Z [TRACE] Request 1237: Incoming payload { id: 4, action: "ping" }
2026-06-17T18:00:17Z [INFO] Handled Request 1237 successfully
2026-06-17T18:00:18Z [DEBUG] Connection pool size: 5, active: 2
2026-06-17T18:00:19Z [TRACE] Request 1238: Incoming payload { id: 5, action: "ping" }
2026-06-17T18:00:20Z [INFO] Handled Request 1238 successfully
2026-06-17T18:00:21Z [DEBUG] Connection pool size: 5, active: 1
2026-06-17T18:00:22Z [TRACE] System standby...
`;

const agentSystemPrompt = `You are a helpful assistant. Available agent types for the Agent tool:
- claude: A general purpose coding agent. It can run tools and write code. Launch it when you need to delegate a task. It runs concurrently.
- claude-code-guide: Use this for answering questions about Claude Code, CLI, SDK, API. Tools: Bash, Read, WebFetch, WebSearch. Check existing/completed first!
- Explore: Read-only sweeping search. Reads excerpts, no audits. Tools: All except Agent, ExitPlanMode, Edit, Write, NotebookEdit
- general-purpose: Multi-step tasks/complex research. Tools: *
- Plan: Design implementation plans/architect. Tools: All except Agent, ExitPlanMode, Edit, Write, NotebookEdit
- statusline-setup: Configure statusline. Tools: Read, Edit.

The following skills are available for use with the Skill tool:
- deep-research: Fact-checked report. Ask clarifying Qs if vague.
- update-config: Modify settings.json for hooks, permissions, env vars.
- keybindings-help: Customize keys in ~/.claude/keybindings.json.
- verify: Verify fixes/PRs by running app & manual check.
- code-review: Review diff for bugs/cleanup. --comment or --fix.
- simplify: Refactor code for quality/reusability. No bug hunting.
- fewer-permission-prompts: Add common Bash/MCP tools to settings.json allowlist.
- loop: Run command/prompt on interval, e.g. /loop 5m /foo. Omit interval to self-pace.
- claude-api: API/SDK ref. TRIGGER: read BEFORE opening file if Claude/Anthropic/LLM/MCP is named. SKIP: if OpenAI/Gemini/GPT/Llama/Mistral/Ollama is named or in grep 'openai|google.generativeai|genai|mistralai|cohere|ollama'
- run: Launch/test app. Use project skill or defaults.
- init: Init CLAUDE.md with docs.
- review: Review PR.
- security-review: PR/branch security review.

<system-reminder>
Remember to write clean code, handle errors, follow the prompt exactly, and keep responses concise.
</system-reminder>`;

const toolsList = [
  {
    name: "read_file",
    description: "Read file reads the content of a file on the local filesystem.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path of the file to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write file writes content to a file on the local filesystem.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path of the file to write" },
        content: { type: "string", description: "The content of the file" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "execute_bash",
    description: "Executes a bash command in the terminal workspace.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" }
      },
      required: ["command"]
    }
  },
  {
    name: "deploy_lambda",
    description: "Deploy lambda deploys a serverless function to AWS Lambda infrastructure.",
    input_schema: {
      type: "object",
      properties: {
        function_name: { type: "string", description: "The function name of the AWS Lambda function to deploy" },
        role_arn: { type: "string", description: "The role arn for AWS Lambda permission access roles" }
      },
      required: ["function_name"]
    }
  },
  {
    name: "query_postgres",
    description: "Query postgres queries the postgres database with custom SQL string queries.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query string to send to SQL database" },
        connection_string: { type: "string", description: "The connection string to connect to database" }
      },
      required: ["query"]
    }
  },
  {
    name: "git_commit",
    description: "Git commit commits changes to the local git repository.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message of the commit" }
      },
      required: ["message"]
    }
  },
  {
    name: "git_push",
    description: "Git push pushes committed changes to remote repository origin branch.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "The branch name to push to" }
      }
    }
  },
  {
    name: "docker_build",
    description: "Docker build builds a Docker container image using a local Dockerfile.",
    input_schema: {
      type: "object",
      properties: {
        dockerfile: { type: "string", description: "The dockerfile path" }
      }
    }
  },
  {
    name: "run_linter",
    description: "Runs code checks and style checks on files.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file path of the file to check" }
      }
    }
  },
  {
    name: "format_code",
    description: "Format code format_code formats the target source files using prettier.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file path of the file to format" }
      }
    }
  },
  {
    name: "slack_notify",
    description: "Slack notify sends a text notification message to the Slack channel hook.",
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "The channel identifier" },
        text: { type: "string", description: "The text message content to send" }
      },
      required: ["channel", "text"]
    }
  },
  {
    name: "jira_create_issue",
    description: "Creates an issue card inside Jira tracking software boards.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The title of the issue" },
        project_key: { type: "string", description: "The project key" }
      },
      required: ["title", "project_key"]
    }
  },
  {
    name: "s3_upload",
    description: "Uploads binary assets directly into Amazon Web Services Simple Storage Service bucket.",
    input_schema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "The bucket name to upload files" },
        key: { type: "string", description: "The key name for S3" }
      },
      required: ["bucket", "key"]
    }
  },
  {
    name: "k8s_deploy",
    description: "Deploys pods to Kubernetes cluster namespace environments.",
    input_schema: {
      type: "object",
      properties: {
        manifest: { type: "string", description: "The manifest contents" }
      }
    }
  },
  {
    name: "npm_install",
    description: "Installs dependencies inside workspace root node_modules.",
    input_schema: {
      type: "object",
      properties: {
        dependency: { type: "string", description: "The dependency to install" }
      }
    }
  },
  {
    name: "npm_test",
    description: "Runs npm tests inside the monorepo root package json workspace.",
    input_schema: {
      type: "object",
      properties: {
        suite: { type: "string", description: "The suite name to execute tests on" }
      }
    }
  },
  {
    name: "web_search",
    description: "Performs queries on web search engines to extract research information.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The query to search" }
      },
      required: ["query"]
    }
  },
  {
    name: "send_email",
    description: "Sends automated emails using corporate SMTP exchange servers.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The to email address recipient" },
        body: { type: "string", description: "The body text content of the email" }
      },
      required: ["to", "body"]
    }
  }
];

const commits = [];
for (let i = 0; i < 80; i++) {
  commits.push({
    commit: `a9f10a8e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d${i}`,
    author: `Developer ${i} <dev${i}@example.com>`,
    date: new Date(2026, 5, (i % 30) + 1).toISOString(),
    message: `Commit message number ${i} which represents some change we made in file number ${i}`,
    filesChanged: [`src/file_${i}.ts`, `tests/file_${i}.test.ts`],
    insertions: i * 2,
    deletions: i
  });
}
const largeToolPayload = JSON.stringify(commits);

const deduplicationMockData = `Running test suite...
${'Error: Failed to fetch user profile from auth service, retrying...\\n  at fetchUserProfile (/app/src/auth.js:25:9)\\n  at processTicksAndRejections (internal/process/task_queues.js:97:5)\\n\\n'.repeat(15)}
Test suite finished.`;

const contextAnalyzerMockReq = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  stream: false,
  messages: [
    {
      role: 'user',
      content: `Please review my package lock dependencies:
File: package-lock.json
\`\`\`json
"dependencies": {
  "react": "^18.2.0",
  "lodash": "^4.17.21"
}
\`\`\`
And check this code:
\`\`\`javascript
// This function adds two numbers
function add(a, b) {
  /* Return the sum */
  return a + b;
}
\`\`\`
Here is some unstructured JSON payload:
{
  "key1": "value1",
  "key2": "value2"
}`
    }
  ]
};

const endToEndMockReq = {
  model: 'claude-opus-4-8',
  messages: [
    {
      role: 'system',
      content: agentSystemPrompt
    },
    {
      role: 'user',
      content: conversationalBoilerplate + '\n\n' + `Here is my project data:
<file_content path="package-lock.json">
{
  "name": "huge-project",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "node_modules/lodash": { "version": "4.17.21" },
    "node_modules/react": { "version": "18.2.0" }
    ${',"node_modules/foo": { "version": "1.0.0" }'.repeat(500)}
  }
}
</file_content>

<file_content path="src/auth.ts">
/**
 * Main authentication service
 */
export class AuthService {
  async login(user: string) {
    /* 
     * Long boilerplate comments here ...
     */
    ${'console.log("Checking user...");\\n    '.repeat(100)}
    throw new Error("NullPointerException in AuthService");
  }
}
</file_content>

<file_content path="src/irrelevant1.ts">
export const A = 1;
</file_content>

<file_content path="src/irrelevant2.ts">
export const B = 2;
</file_content>

<file_content path="src/irrelevant3.ts">
export const C = 3;
</file_content>
`
    },
    {
      role: 'assistant',
      content: 'I need to check the logs.'
    },
    {
      role: 'user',
      content: deduplicationMockData
    }
  ]
};

// --- BENCHMARK EXECUTION ---

async function runBenchmark() {
  console.log('Running TokenWall Prompt & Tool Optimization Benchmarks...');
  
  const model = 'claude-opus-4-8';
  const inputPricePerM = 5.00; // $5.00 per Million
  
  const results = [];
  const optimizer = new PromptOptimizer();

  // Case 1: Conversational Filler Removal
  {
    const start = performance.now();
    const optRes = optimizer.optimize(conversationalBoilerplate, model);
    const latency = performance.now() - start;

    results.push({
      id: 'conversational_fillers',
      name: 'Boilerplate Stripping',
      description: 'Removes polite phrases, redundant directives, and conversational fluff.',
      beforeText: conversationalBoilerplate,
      afterText: optRes.optimizedText,
      beforeTokens: countTokens(conversationalBoilerplate, model),
      afterTokens: countTokens(optRes.optimizedText, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 2: Agent System Prompt Compression
  {
    const start = performance.now();
    const optRes = optimizer.optimize(agentSystemPrompt, model);
    const latency = performance.now() - start;

    results.push({
      id: 'system_prompt_compression',
      name: 'System Prompt Semantic Compression',
      description: 'Compresses large system prompts, including agent definitions, skills systems, and system reminders.',
      beforeText: agentSystemPrompt,
      afterText: optRes.optimizedText,
      beforeTokens: countTokens(agentSystemPrompt, model),
      afterTokens: countTokens(optRes.optimizedText, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 3: Tool Routing / Pruning
  {
    const start = performance.now();
    const recentMessages = [
      { role: 'user', content: 'Please read the index.ts file and explain the main function exports.' }
    ];
    const routedTools = ToolRouter.route(toolsList, recentMessages);
    const latency = performance.now() - start;

    const beforeText = JSON.stringify(toolsList);
    const afterText = JSON.stringify(routedTools);

    results.push({
      id: 'tool_routing',
      name: 'Dynamic Tool Router Pruning',
      description: 'Prunes irrelevant tools from the list when the tool library size exceeds 15 based on conversation context.',
      beforeText,
      afterText,
      beforeTokens: countTokens(beforeText, model),
      afterTokens: countTokens(afterText, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 4: Tool Schema Optimization
  {
    const start = performance.now();
    const optimizedTools = ToolSchemaOptimizer.optimize(toolsList, true);
    const latency = performance.now() - start;

    const beforeText = JSON.stringify(toolsList);
    const afterText = JSON.stringify(optimizedTools);

    results.push({
      id: 'tool_schema_optimization',
      name: 'Tool Schema Description Minimization',
      description: 'Strips tautological parameter descriptions and truncates verbose schemas.',
      beforeText,
      afterText,
      beforeTokens: countTokens(beforeText, model),
      afterTokens: countTokens(afterText, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 5: Tool Payload Crushing
  {
    const start = performance.now();
    const crushedPayload = ToolPayloadCrusher.optimizeToolResult(largeToolPayload, model);
    const latency = performance.now() - start;

    results.push({
      id: 'tool_payload_crushing',
      name: 'Tool Response Payload Crushing',
      description: 'Applies head-tail truncation to huge JSON array structures in tool outputs under token budget constraints.',
      beforeText: largeToolPayload,
      afterText: crushedPayload,
      beforeTokens: countTokens(largeToolPayload, model),
      afterTokens: countTokens(crushedPayload, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 6: Context Deduplication
  {
    const start = performance.now();
    const optRes = optimizer.optimize(deduplicationMockData, model);
    const latency = performance.now() - start;

    results.push({
      id: 'context_deduplication',
      name: 'Context Deduplication',
      description: 'Strips out exact duplicate chunks (e.g. repeated logs/stack traces) separated by double newlines.',
      beforeText: deduplicationMockData,
      afterText: optRes.optimizedText,
      beforeTokens: countTokens(deduplicationMockData, model),
      afterTokens: countTokens(optRes.optimizedText, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 7: Context Analyzer (Code Compression, JSON Crushing, Lockfiles)
  {
    const analyzer = new ContextAnalyzer();
    const beforeTokens = countTokens(contextAnalyzerMockReq.messages[0].content, model);
    
    const start = performance.now();
    const report = await analyzer.analyze(contextAnalyzerMockReq);
    const latency = performance.now() - start;

    const afterTokens = countTokens(report.cleanMessages[0].content, model);
    
    results.push({
      id: 'context_analyzer',
      name: 'Structural Context Analyzer',
      description: 'Applies robust structure-aware compressions: JSON minification, code comment stripping, and reversible lockfile truncation.',
      beforeText: contextAnalyzerMockReq.messages[0].content,
      afterText: report.cleanMessages[0].content,
      beforeTokens: beforeTokens,
      afterTokens: afterTokens,
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 8: Unstructured Log Pruning via Importance Engine
  {
    const analyzer = new ContextAnalyzer();
    const config = { importance: { policy: 'balanced' }, codeCompression: false, jsonCrushing: false };
    
    const request = {
      model: model,
      messages: [{ role: "user", content: mockServerLog }],
      tools: []
    };

    const start = performance.now();
    const result = await analyzer.analyze(request, config);
    const latency = performance.now() - start;

    results.push({
      id: 'importance_scoring_logs',
      name: 'Importance Log Pruning',
      description: 'Prunes low-importance (INFO/DEBUG) log lines while preserving ERRORs based on threshold.',
      beforeText: mockServerLog,
      afterText: result.cleanMessages[0].content,
      beforeTokens: countTokens(mockServerLog, model),
      afterTokens: countTokens(result.cleanMessages[0].content, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 9: Query-Aware Code Compression
  {
    const analyzer = new ContextAnalyzer();
    const config = { importance: { policy: 'balanced' }, jsonCrushing: false, codeCompression: true };
    
    const queryAwareReq = {
      model: model,
      messages: [
        { role: "user", content: "Please fix the JWT validation logic." },
        { role: "assistant", content: "Here is the code context:\n```typescript\n/**\n * JWT Auth validator\n * @param token\n */\nfunction validateJWT(token: string) { return true; }\n```\n\n```css\n/* Main button styles */\n.btn { color: red; }\n```" }
      ],
      tools: []
    };

    const start = performance.now();
    const result = await analyzer.analyze(queryAwareReq, config);
    const latency = performance.now() - start;

    results.push({
      id: 'query_aware_compression',
      name: 'Task-Aware Code Compression',
      description: 'Preserves comments on files matching user query, aggressively minifies irrelevant files.',
      beforeText: queryAwareReq.messages[1].content,
      afterText: result.cleanMessages[1].content,
      beforeTokens: countTokens(queryAwareReq.messages[1].content, model),
      afterTokens: countTokens(result.cleanMessages[1].content, model),
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Case 10: End-to-End Realistic Tool Call Workflow
  {
    const analyzer = new ContextAnalyzer();
    
    const beforeTokens = endToEndMockReq.messages.reduce((sum, msg) => sum + countTokens(msg.content, model), 0);
    
    const start = performance.now();
    const report = await analyzer.analyze(endToEndMockReq, { lostInMiddleMitigation: true });
    
    const finalMessages = report.cleanMessages.map(msg => {
      const optRes = optimizer.optimize(msg.content, model);
      return { ...msg, content: optRes.optimizedText };
    });
    const latency = performance.now() - start;

    const afterTokens = finalMessages.reduce((sum, msg) => sum + countTokens(msg.content, model), 0);
    
    results.push({
      id: 'end_to_end_workflow',
      name: 'End-to-End Pipeline (Analyzer + Optimizer)',
      description: 'Simulates a real-world multi-turn payload involving boilerplate, system prompts, large lockfiles, AST compression, deduplication, and U-shaped reordering.',
      beforeText: 'Multi-turn payload...',
      afterText: 'Fully optimized payload...',
      beforeTokens: beforeTokens,
      afterTokens: afterTokens,
      latencyMs: parseFloat(latency.toFixed(2))
    });
  }

  // Add statistics calculations
  let totalBefore = 0;
  let totalAfter = 0;
  let totalLatency = 0;

  const formattedResults = results.map(r => {
    const saved = Math.max(0, r.beforeTokens - r.afterTokens);
    const savingsPercent = r.beforeTokens > 0 ? parseFloat(((saved / r.beforeTokens) * 100).toFixed(1)) : 0;
    
    const costBefore = (r.beforeTokens / 1000000) * inputPricePerM;
    const costAfter = (r.afterTokens / 1000000) * inputPricePerM;
    const costSaved = Math.max(0, costBefore - costAfter);

    totalBefore += r.beforeTokens;
    totalAfter += r.afterTokens;
    totalLatency += r.latencyMs;

    return {
      ...r,
      tokensSaved: saved,
      savingsPercent,
      costBefore: parseFloat(costBefore.toFixed(5)),
      costAfter: parseFloat(costAfter.toFixed(5)),
      costSaved: parseFloat(costSaved.toFixed(5))
    };
  });

  const totalSaved = totalBefore - totalAfter;
  const overallSavingsPercent = parseFloat(((totalSaved / totalBefore) * 100).toFixed(1));
  const totalCostBefore = (totalBefore / 1000000) * inputPricePerM;
  const totalCostAfter = (totalAfter / 1000000) * inputPricePerM;
  const totalCostSaved = totalCostBefore - totalCostAfter;

  // Let's model a developer workspace daily scenario
  // A developer makes ~200 runs of their coding agent loops per day.
  const dailyRuns = 200;
  const dailyTokensBefore = totalBefore * dailyRuns;
  const dailyTokensAfter = totalAfter * dailyRuns;
  const dailySavedTokens = dailyTokensBefore - dailyTokensAfter;
  
  const dailyCostBefore = (dailyTokensBefore / 1000000) * inputPricePerM;
  const dailyCostAfter = (dailyTokensAfter / 1000000) * inputPricePerM;
  const dailyCostSaved = dailyCostBefore - dailyCostAfter;

  const monthlyCostBefore = dailyCostBefore * 30;
  const monthlyCostAfter = dailyCostAfter * 30;
  const monthlyCostSaved = dailyCostSaved * 30;

  const summary = {
    model,
    inputPricePerM,
    aggregate: {
      beforeTokens: totalBefore,
      afterTokens: totalAfter,
      tokensSaved: totalSaved,
      savingsPercent: overallSavingsPercent,
      costBefore: parseFloat(totalCostBefore.toFixed(4)),
      costAfter: parseFloat(totalCostAfter.toFixed(4)),
      costSaved: parseFloat(totalCostSaved.toFixed(4)),
      avgLatencyMs: parseFloat((totalLatency / results.length).toFixed(2))
    },
    projections: {
      dailyRuns,
      dailyTokensSaved: dailySavedTokens,
      dailyCostBefore: parseFloat(dailyCostBefore.toFixed(2)),
      dailyCostAfter: parseFloat(dailyCostAfter.toFixed(2)),
      dailyCostSaved: parseFloat(dailyCostSaved.toFixed(2)),
      monthlyCostBefore: parseFloat(monthlyCostBefore.toFixed(2)),
      monthlyCostAfter: parseFloat(monthlyCostAfter.toFixed(2)),
      monthlyCostSaved: parseFloat(monthlyCostSaved.toFixed(2))
    }
  };

  const outputData = {
    summary,
    benchmarks: formattedResults
  };

  const jsonPath = path.join(__dirname, 'eval_results_data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(outputData, null, 2));

  console.log('\n======================================================');
  console.log('OPTIMIZATION EVALUATION COMPLETED');
  console.log('======================================================');
  console.log(`Model: ${model} ($${inputPricePerM}/M input tokens)`);
  console.log(`Total Before: ${totalBefore.toLocaleString()} tokens`);
  console.log(`Total After: ${totalAfter.toLocaleString()} tokens`);
  console.log(`Saved: ${totalSaved.toLocaleString()} tokens (${overallSavingsPercent}% reduction)`);
  console.log(`Cost Before (1 call): $${totalCostBefore.toFixed(4)}`);
  console.log(`Cost After (1 call):  $${totalCostAfter.toFixed(4)}`);
  console.log(`Avg Local Latency:    ${(totalLatency / results.length).toFixed(2)}ms`);
  console.log('------------------------------------------------------');
  console.log('PROJECTED MONTHLY SAVINGS (200 agent loops/day):');
  console.log(`Spend Without TokenWall: $${monthlyCostBefore.toFixed(2)}`);
  console.log(`Spend With TokenWall:    $${monthlyCostAfter.toFixed(2)}`);
  console.log(`Monthly Dollars Saved:   $${monthlyCostSaved.toFixed(2)} (${overallSavingsPercent}% savings)`);
  console.log('======================================================\n');

  console.log(`Detailed metrics written to: ${jsonPath}`);
}

runBenchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
