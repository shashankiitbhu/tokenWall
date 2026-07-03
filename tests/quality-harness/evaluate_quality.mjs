import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContextAnalyzer } from '../../packages/context-engine/dist/index.js';
import { PromptOptimizer } from '../../packages/prompt-optimizer/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TARGET_MODEL = 'gemini-3.5-flash';
const JUDGE_MODEL = 'gemini-3.1-pro-preview';

if (!GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable is required.");
  process.exit(1);
}

async function callLLM(model, messages, tools) {
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');

  const contents = otherMsgs.map(m => {
    let role = m.role === 'assistant' ? 'model' : m.role;
    let parts = [];
    if (m.role === 'tool') {
      role = 'user';
      parts = [{
        functionResponse: { name: m.name || 'unknown_tool', response: { result: m.content } }
      }];
    } else {
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (e) { }
          parts.push({
            functionCall: { name: tc.function.name, args }
          });
        }
      }
    }
    return { role, parts };
  });

  const payload = { contents };
  if (systemMsg) {
    payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  if (tools && tools.length > 0) {
    const functionDeclarations = tools.map(t => {
      const props = {};
      if (t.function.parameters?.properties) {
        for (const [k, v] of Object.entries(t.function.parameters.properties)) {
          props[k] = { type: (v.type || 'STRING').toUpperCase(), description: v.description };
        }
      }
      return {
        name: t.function.name,
        description: t.function.description,
        parameters: { type: 'OBJECT', properties: props, required: t.function.parameters?.required || [] }
      };
    });
    payload.tools = [{ functionDeclarations }];
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const resBody = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API Error: ${res.status} ${JSON.stringify(resBody)}`);
  }

  if (!resBody.candidates || resBody.candidates.length === 0) {
    return { choices: [{ message: { content: "" } }] };
  }

  const part = resBody.candidates[0].content?.parts?.[0] || {};
  if (part.functionCall) {
    return {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args)
            }
          }]
        }
      }]
    };
  }

  return { choices: [{ message: { content: part.text || "" } }] };
}

async function runJudge(fixture, agentRequest, agentResponse) {
  const judgePrompt = `
You are an expert evaluating the performance of an AI coding agent.

[Task Request]
The agent received the following request:
${JSON.stringify(agentRequest, null, 2)}

[Success Criteria]
${fixture.success_criteria}

[Agent Response]
The agent produced the following response (including tool calls if any):
${JSON.stringify(agentResponse.choices[0].message, null, 2)}

Does the agent's response meet the success criteria for the task outcome?
Respond ONLY with a JSON object in this exact format:
{
  "pass": true|false,
  "reasoning": "short explanation of why"
}
`;

  const response = await callLLM(JUDGE_MODEL, [{ role: 'user', content: judgePrompt }], []);
  try {
    let content = response.choices[0].message.content;
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(content);
  } catch (e) {
    console.error("Failed to parse judge output:", response.choices[0].message.content);
    return { pass: false, reasoning: "Judge output unparseable." };
  }
}

async function runEvaluation() {
  console.log('--- Starting TokenWall Regression Evaluation Harness ---\n');

  const datasetPath = path.join(__dirname, 'dataset');
  const files = await fs.readdir(datasetPath);

  const analyzer = new ContextAnalyzer();
  const optimizer = new PromptOptimizer();

  let totalTests = 0;
  let optimizedPasses = 0;
  let controlPasses = 0;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    totalTests++;

    console.log(`▶️ Evaluating fixture: ${file}`);
    const fixtureData = await fs.readFile(path.join(datasetPath, file), 'utf-8');
    const fixture = JSON.parse(fixtureData);

    const rawRequest = fixture.request;

    // 1. Run TokenWall optimization pipeline
    console.log('   Running context optimizations...');
    // We pass the raw request through ContextAnalyzer
    const analyzerReport = await analyzer.analyze({
      provider: rawRequest.provider,
      model: rawRequest.model,
      messages: rawRequest.messages,
      stream: rawRequest.stream,
      toolsAttached: rawRequest.tools && rawRequest.tools.length > 0,
      toolsSchemaText: (rawRequest.tools && rawRequest.tools.length > 0) ? JSON.stringify(rawRequest.tools) : undefined,
      rawBody: rawRequest
    }, {
      codeCompression: true,
      jsonCrushing: true,
      importance: { policy: 'balanced' }
    });

    const hasEditTools = rawRequest.tools && rawRequest.tools.some(t => 
      ['replace_file_content', 'insert_at_line', 'edit_file', 'write_to_file', 'apply_diff'].includes(t.function.name)
    );

    const optimizedMessages = analyzerReport.cleanMessages.map(m => ({
      role: m.role,
      content: optimizer.optimize(m.content, TARGET_MODEL, { disableCodeCompression: hasEditTools }).optimizedText
    }));

    // 2. Query target model with OPTIMIZED payload
    console.log('   Querying target LLM with optimized payload...');
    const optResponse = await callLLM(TARGET_MODEL, optimizedMessages, rawRequest.tools);

    // 3. Query target model with RAW payload (Control)
    console.log('   Querying target LLM with raw payload (Control)...');
    const rawResponse = await callLLM(TARGET_MODEL, rawRequest.messages, rawRequest.tools);

    // 4. Judge results
    console.log('   Evaluating outcomes using LLM-as-a-Judge...');
    const optJudge = await runJudge(fixture, rawRequest.messages, optResponse);
    const rawJudge = await runJudge(fixture, rawRequest.messages, rawResponse);

    if (optJudge.pass) optimizedPasses++;
    if (rawJudge.pass) controlPasses++;

    console.log(`\n   [Control] Pass: ${rawJudge.pass} | Reason: ${rawJudge.reasoning}`);
    console.log(`   [Optimized] Pass: ${optJudge.pass} | Reason: ${optJudge.reasoning}`);

    if (rawJudge.pass && !optJudge.pass) {
      console.log('   ⚠️ REGRESSION DETECTED: Control passed but optimized failed.');
    } else if (!rawJudge.pass && !optJudge.pass) {
      console.log('   ℹ️ NO REGRESSION: Both control and optimized failed (likely a hard task or weak target model).');
    } else {
      console.log('   ✅ OPTIMIZATION SUCCESSFUL: Optimized payload performed successfully.');
    }
    console.log('----------------------------------------------------');
  }

  console.log('\n--- Final Quality Report ---');
  console.log(`Total Fixtures: ${totalTests}`);
  console.log(`Control Pass Rate: ${((controlPasses / totalTests) * 100).toFixed(1)}%`);
  console.log(`Optimized Pass Rate: ${((optimizedPasses / totalTests) * 100).toFixed(1)}%`);

  if (optimizedPasses < controlPasses) {
    console.error('❌ OVERALL REGRESSION DETECTED. Optimizations are degrading task success.');
    process.exit(1);
  } else {
    console.log('🎉 REGRESSION CHECK PASSED. Quality maintained or improved.');
  }
}

runEvaluation().catch(e => {
  console.error("Evaluation failed:", e);
  process.exit(1);
});
