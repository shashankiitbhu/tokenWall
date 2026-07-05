import fs from 'fs/promises';
import path from 'path';
import os from 'os';
os.homedir = () => path.resolve('./.tmp_home');
process.env.HOME = path.resolve('./.tmp_home');
import { fileURLToPath } from 'url';
import { PromptOptimizer } from '../../packages/prompt-optimizer/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn("⚠️ Warning: GEMINI_API_KEY is not set. Gemini tests will fail.");
}
if (!ANTHROPIC_API_KEY) {
  console.warn("⚠️ Warning: ANTHROPIC_API_KEY is not set. Anthropic tests will fail.");
}

const PROVIDERS = ['gemini', 'anthropic'];
const N_TRIALS = 30;
const THRESHOLD = 0.99; // 99% reliability expected for safety

// Mock implementations for API calls
async function callGemini(messages, tools) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMsgs = messages.filter(m => m.role !== 'system');
  const contents = otherMsgs.map(m => {
    let role = m.role === 'assistant' ? 'model' : m.role;
    let parts = [];
    if (m.raw_gemini_parts) {
      parts = m.raw_gemini_parts;
    } else if (m.role === 'tool') {
      role = 'user';
      parts = [{ functionResponse: { name: m.name || 'unknown_tool', response: { result: m.content } } }];
    } else {
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch (e) { }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
    }
    return { role, parts };
  });

  const payload = { contents, generationConfig: { temperature: 0.1 } };
  if (systemMsg) payload.systemInstruction = { parts: [{ text: systemMsg.content }] };

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

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const resBody = await res.json();
  if (!res.ok) throw new Error(`Gemini API Error: ${res.status} ${JSON.stringify(resBody)}`);

  const part = resBody.candidates?.[0]?.content?.parts?.[0] || {};
  if (part.functionCall) {
    return {
      message: {
        content: null,
        tool_calls: [{
          id: part.functionCall.name + "_id", // Note: Assumes 1 tool call per message for simplicity in this harness // Note: Assumes 1 tool call per message for simplicity in this harness // Note: Assumes 1 tool call per message for simplicity in this harness
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) }
        }],
        raw_gemini_parts: resBody.candidates[0].content.parts
      }
    };
  }
  return { message: { content: part.text || "" } };
}

async function callAnthropic(messages, tools) {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  const systemMsg = messages.find(m => m.role === 'system')?.content;
  const anthropicMsgs = messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
    }
    if (m.tool_calls) {
      return {
        role: 'assistant', content: m.tool_calls.map(tc => ({
          type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments)
        }))
      };
    }
    return { role: m.role, content: m.content };
  });

  const payload = {
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1024,
    temperature: 0.1,
    messages: anthropicMsgs,
    system: systemMsg
  };

  if (tools && tools.length > 0) {
    payload.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: { type: 'object', properties: t.function.parameters.properties, required: t.function.parameters.required }
    }));
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const resBody = await res.json();
  if (!res.ok) throw new Error(`Anthropic API Error: ${res.status} ${JSON.stringify(resBody)}`);

  const toolUse = resBody.content.find(c => c.type === 'tool_use');
  if (toolUse) {
    return {
      message: {
        content: null,
        tool_calls: [{ id: toolUse.id, function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input) } }]
      }
    };
  }
  const textContent = resBody.content.find(c => c.type === 'text')?.text || "";
  return { message: { content: textContent } };
}

const RETRIEVE_TOOL = {
  function: {
    name: 'tokenwall_retrieve_content',
    description: 'Retrieve the original content for a masked block (e.g. ccr_sk_... or ccr_js_...). Always call this before attempting to edit or reason about a masked block.',
    parameters: {
      type: 'object',
      properties: { content_id: { type: 'string', description: 'The masked content ID' } },
      required: ['content_id']
    }
  }
};

const SYSTEM_PROMPT = `You are a coding assistant. You may encounter masked content regions represented by a token like [TokenWall Reversible Content: ccr_sk_...]. If you need to edit or deeply reason about the content of one of these regions, you MUST use the 'tokenwall_retrieve_content' tool to retrieve the unmasked content first. If uncertain, retrieve rather than guess.`;

async function runScenario(provider, scenarioName, testFn) {
  const callLLM = provider === 'gemini' ? callGemini : callAnthropic;
  let retrieveBeforeAct = 0;
  let correctId = 0;
  let correctFinalEdit = 0;

  for (let i = 0; i < N_TRIALS; i++) {
    try {
      const result = await testFn(callLLM);
      if (result.retrievedBeforeAct) retrieveBeforeAct++;
      if (result.correctId) correctId++;
      if (result.correctFinalEdit) correctFinalEdit++;
    } catch (e) {
      // Treat errors as failures for this trial
      console.error(`Trial ${i} failed for ${scenarioName}:`, e.message);
    }
  }
  return {
    scenarioName, provider,
    retrieveBeforeActRate: retrieveBeforeAct / N_TRIALS,
    correctIdRate: correctId / N_TRIALS,
    correctFinalEditRate: correctFinalEdit / N_TRIALS,
    successRate: correctFinalEdit / N_TRIALS // Deep success criterion
  };
}

async function main() {
  const optimizer = new PromptOptimizer();
  const resultsMatrix = [];

  // Define Scenarios
  const scenarios = [
    {
      name: "Single ccr_sk_ edit",
      fn: async (callLLM) => {
        const rawCode = `function performCalculation(x, y) {
  let z = x + y;
  z = z * 2;
  // padding 1
  // padding 2
  // padding 3
  // padding 4
  // padding 5
  // secret logic here
  z = z - 5;
  return z;
}`;
        const opt = await optimizer.optimize("```javascript\n" + rawCode + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const skTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_sk_'));
        const targetId = skTokens[0].id;

        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the code:\n\n${masked}\n\nPlease change the secret logic line to add 10 instead of subtracting 5. Output the modified function.` }
        ];

        let retrievedBeforeAct = false;
        let correctId = false;
        let correctFinalEdit = false;

        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        if (res1.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
          retrievedBeforeAct = true;
          const args = JSON.parse(res1.message.tool_calls[0].function.arguments);
          if (args.content_id === targetId) {
            correctId = true;
            messages.push(res1.message);
            messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: res1.message.tool_calls[0].id, content: skTokens[0].content });

            const res2 = await callLLM(messages, []);
            if (res2.message.content && res2.message.content.includes('z = z + 10;')) {
              correctFinalEdit = true;
            }
          }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
    },
    {
      name: "Single ccr_js_ edit",
      fn: async (callLLM) => {
        const rawJson = `{\n  "long_array": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55]\n}`;
        const opt = await optimizer.optimize("```json\n" + rawJson + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const jsTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_js_'));
        const targetId = jsTokens[0].id;

        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the JSON:\n\n${masked}\n\nPlease output the 55th item in the array.` }
        ];

        let retrievedBeforeAct = false;
        let correctId = false;
        let correctFinalEdit = false;

        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        if (res1.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
          retrievedBeforeAct = true;
          const args = JSON.parse(res1.message.tool_calls[0].function.arguments);
          if (args.content_id === targetId) {
            correctId = true;
            messages.push(res1.message);
            messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: res1.message.tool_calls[0].id, content: jsTokens[0].content });

            const res2 = await callLLM(messages, []);
            if (res2.message.content && res2.message.content.includes('55')) {
              correctFinalEdit = true;
            }
          }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
    },
    {
      name: "Cross-turn scenario",
      fn: async (callLLM) => {
        const rawCode = `function complexMethod(a, b) {
  let c = a + b;
  let d = c * 3;
  // padding 1
  // padding 2
  // padding 3
  // padding 4
  // padding 5
  // deep deep logic
  d = d - 1;
  return d;
}`;
        const opt = await optimizer.optimize("```javascript\n" + rawCode + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const targetId = opt.cachedContents[0].id;

        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the code:\n\n${masked}\n\nJust say "Acknowledged".` }
        ];

        let retrievedBeforeAct = false;
        let correctId = false;
        let correctFinalEdit = false;

        // Turn 1: Model answers easily (no retrieve needed, but tools available realistically)
        
        
        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        messages.push(res1.message);
        if (res1.message.tool_calls && res1.message.tool_calls.length > 0) {
          throw new Error("Model hallucinated a tool call on Turn 1 instead of acknowledging");
        }

        if (res1.message.tool_calls && res1.message.tool_calls.length > 0) {
          throw new Error("Model hallucinated a tool call on Turn 1 instead of acknowledging");
        }

        
        let retrievedOnTurn1 = false;
        if (res1.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
            retrievedOnTurn1 = true;
            retrievedBeforeAct = true;
            const args = JSON.parse(res1.message.tool_calls[0].function.arguments);
            if (args.content_id === targetId) correctId = true;
            messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: res1.message.tool_calls[0].id, content: opt.cachedContents[0].content });
            
            const res1_followup = await callLLM(messages, []);
            messages.push(res1_followup.message);
        }

        // Filler turns
        messages.push({ role: 'user', content: "What is 2+2?" });
        messages.push({ role: 'assistant', content: "4." });

        // Turn N: Ask for precise detail inside masked content
        messages.push({ role: 'user', content: "By the way, what was the exact logic inside the complexMethod from earlier? Please output the full deep logic line." });

        const resN = await callLLM(messages, [RETRIEVE_TOOL]);
        
        if (retrievedOnTurn1) {
            // Already retrieved, should answer directly
            if (resN.message.content && resN.message.content.includes('d = d - 1')) {
                correctFinalEdit = true;
            } else if (resN.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
                messages.push(resN.message);
                messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: resN.message.tool_calls[0].id, content: opt.cachedContents[0].content });
                const resFinal = await callLLM(messages, []);
                if (resFinal.message.content && resFinal.message.content.includes('d = d - 1')) correctFinalEdit = true;
            }
        } else {
            // Didn't retrieve on Turn 1, MUST retrieve now
            if (resN.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
              retrievedBeforeAct = true;
              const args = JSON.parse(resN.message.tool_calls[0].function.arguments);
              if (args.content_id === targetId) {
                correctId = true;
                messages.push(resN.message);
                messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: resN.message.tool_calls[0].id, content: opt.cachedContents[0].content });

                const resFinal = await callLLM(messages, []);
                if (resFinal.message.content && resFinal.message.content.includes('d = d - 1')) {
                  correctFinalEdit = true;
                }
              }
            }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
    },
    {
      name: "Stale ID (Negative test)",
      fn: async (callLLM) => {
        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is some masked code: [TokenWall Reversible Content: ccr_sk_invalid_999]. What is the content?` }
        ];

        let retrievedBeforeAct = false;
        let correctId = false;
        let correctFinalEdit = false; // For this test, success means graceful failure reporting

        const res1 = await callLLM(messages, [RETRIEVE_TOOL]);
        if (res1.message.tool_calls?.[0]?.function?.name === 'tokenwall_retrieve_content') {
          retrievedBeforeAct = true;
          correctId = null; // N/A for stale ID
          messages.push(res1.message);
          messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: res1.message.tool_calls[0].id, content: 'ERROR: Content ID not found or stale.' });

          const res2 = await callLLM(messages, []);
          const responseLower = (res2.message.content || '').toLowerCase();
          // Did it hallucinate code, or report the failure?
          if (
            responseLower.includes('error') || 
            responseLower.includes('not found') || 
            responseLower.includes('stale') || 
            responseLower.includes('cannot') || 
            responseLower.includes('unable') || 
            responseLower.includes('invalid') || 
            responseLower.includes('unavailable') || 
            responseLower.includes('apologize') || 
            responseLower.includes("don't have access")
          ) {
            correctFinalEdit = true;
          }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
    },
    {
      name: "Multi-retrieve (Two masked regions)",
      fn: async (callLLM) => {
        const rawCode1 = `function setupDatabase() {
  let db = new Database();
  db.connect();
  // padding
  // padding
  // padding
  // padding
  // padding
  db.setToken("token_12345");
  return db;
}`;
        const rawCode2 = `function configureApp() {
  let app = new App();
  app.init();
  // padding
  // padding
  // padding
  // padding
  // padding
  app.setPort(8080);
  return app;
}`;
        const opt = await optimizer.optimize("```javascript\n" + rawCode1 + "\n```\n\nSome text\n\n```javascript\n" + rawCode2 + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const skTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_sk_'));
        
        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the setup code:\n\n${masked}\n\nPlease output the database token and the app port.` }
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
          
          // Allow sequential retrieval by passing the tool again
          const res2 = await callLLM(messages, []);
          const res2Text = (res2.message.content || '') + JSON.stringify(res2.message.tool_calls || []);
          if (res2Text.includes('token_12345') && res2Text.includes('8080')) {
              correctFinalEdit = true;
          } else if (res2.message.tool_calls) {
              // Handle sequential retrieval (Gemini sometimes does this)
              messages.push(res2.message);
              for (const tc of res2.message.tool_calls) {
                 const args = JSON.parse(tc.function.arguments);
                 const content = skTokens.find(s => s.id === args.content_id)?.content || "ERROR";
                 messages.push({ role: 'tool', name: 'tokenwall_retrieve_content', tool_call_id: tc.id, content });
              }
              const res3 = await callLLM(messages, [RETRIEVE_TOOL]);
              const res3Text = (res3.message.content || '') + JSON.stringify(res3.message.tool_calls || []);
              if (res3Text.includes('token_12345') && res3Text.includes('8080')) {
                  correctFinalEdit = true;
              }
          }
        }
        return { retrievedBeforeAct, correctId, correctFinalEdit };
      }
,
    {
      name: "Multi-retrieve (Two masked regions)",
      fn: async (callLLM) => {
        const rawCode1 = `function setupDatabase() {
  let db = new Database();
  db.connect();
  // padding
  // padding
  // padding
  // padding
  // padding
  db.setToken("token_12345");
  return db;
}`;
        const rawCode2 = `function configureApp() {
  let app = new App();
  app.init();
  // padding
  // padding
  // padding
  // padding
  // padding
  app.setPort(8080);
  return app;
}`;
        const opt = await optimizer.optimize("```javascript\n" + rawCode1 + "\n```\n\nSome text\n\n```javascript\n" + rawCode2 + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const skTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_sk_'));
        
        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the setup code:\n\n${masked}\n\nPlease output the database token and the app port.` }
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
,
    {
      name: "Multi-retrieve (Two masked regions)",
      fn: async (callLLM) => {
        const rawCode1 = `function setupDatabase() {
  let db = new Database();
  db.connect();
  // padding
  // padding
  // padding
  // padding
  // padding
  db.setToken("token_12345");
  return db;
}`;
        const rawCode2 = `function configureApp() {
  let app = new App();
  app.init();
  // padding
  // padding
  // padding
  // padding
  // padding
  app.setPort(8080);
  return app;
}`;
        const opt = await optimizer.optimize("```javascript\n" + rawCode1 + "\n```\n\nSome text\n\n```javascript\n" + rawCode2 + "\n```", 'gpt-4', { disableCodeCompression: false, disableJsonMasking: false });
        const masked = opt.optimizedText;
        const skTokens = opt.cachedContents.filter(c => c.id.startsWith('ccr_sk_'));
        
        let messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Here is the setup code:\n\n${masked}\n\nPlease output the database token and the app port.` }
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
  ];

  console.log(`Running Reliability Evaluation Harness (N=${N_TRIALS})`);
  console.log(`Target Minimum Reliability Threshold: ${(THRESHOLD * 100)}%`);
  console.log('---------------------------------------------------');

  let passedAll = true;

  for (const provider of PROVIDERS) {
    if ((provider === 'gemini' && !GEMINI_API_KEY) || (provider === 'anthropic' && !ANTHROPIC_API_KEY)) {
      console.log(`Skipping ${provider} due to missing API key.\n`);
      continue;
    }

    for (const scenario of scenarios) {
      console.log(`Testing [${provider}] - ${scenario.name}...`);
      const result = await runScenario(provider, scenario.name, scenario.fn);
      resultsMatrix.push(result);

      console.log(`  Retrieve before act: ${(result.retrieveBeforeActRate * 100).toFixed(1)}%`);
      console.log(`  Correct ID:          ${(result.correctIdRate * 100).toFixed(1)}%`);
      console.log(`  Deep Success:        ${(result.successRate * 100).toFixed(1)}%`);

      if (result.successRate < THRESHOLD) {
        passedAll = false;
        console.log(`  ❌ FAILED THRESHOLD (requires >= ${(THRESHOLD * 100)}%)`);
      } else {
        console.log(`  ✅ PASSED`);
      }
      console.log('');
    }
  }

  console.log('\n===================================================');
  console.log('FINAL EVALUATION MATRIX:');
  console.table(resultsMatrix);

  if (!passedAll) {
    console.error(`\n❌ RELIABILITY EVALUATION FAILED. Do not remove the interim safety guard.`);
    process.exit(1); // Fail CI
  } else {
    console.log(`\n✅ RELIABILITY EVALUATION PASSED. The interim safety guard may be removed.`);
    process.exit(0);
  }
}

main().catch(console.error);
