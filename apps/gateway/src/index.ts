import fastify from 'fastify';
import fs from 'fs';
import os from 'os';
import { DBManager, ConfigManager, TokenWallConfig } from '@tokenwall/core';
import { ProviderRegistry, NormalizedRequest, NormalizedResponse } from '@tokenwall/providers';
import { calculatePreFlightEstimation, getPricingForModel, countTokens, TokenAttributionAnalyzer } from '@tokenwall/estimators';
import { BudgetEvaluator, RunawayLoopDetector } from '@tokenwall/budget-engine';
import { ContextAnalyzer } from '@tokenwall/context-engine';
import { ModelRouter } from '@tokenwall/routing-engine';
import { PromptOptimizer, ToolSchemaOptimizer, ToolPayloadCrusher, ToolRouter } from '@tokenwall/prompt-optimizer';
import { TelemetryLogger } from '@tokenwall/telemetry';
import { TerminalUI, c } from '@tokenwall/terminal-ui';
import { createParser } from 'eventsource-parser';
import fastifyWebsocket from '@fastify/websocket';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { controlPlane } from './control-plane.js';

const server = fastify({ logger: false });
server.register(cors as any, { origin: '*' });
server.register(fastifyWebsocket as any);

const getDashboardPath = () => {
  const devPath = path.join(__dirname, '../../dashboard/dist');
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(__dirname, '../dashboard');
  if (fs.existsSync(prodPath)) return prodPath;
  const cliProdPath = path.join(__dirname, '../dashboard/dist');
  if (fs.existsSync(cliProdPath)) return cliProdPath;
  return devPath; // Fallback
};

server.register(fastifyStatic as any, {
  root: getDashboardPath(),
  prefix: '/dashboard/',
});
server.register(async function (f) {
  controlPlane.registerWebsocket(f);
});

console.log("[TokenWall Gateway] Initializing components...");
const db = new DBManager();
console.log("[TokenWall Gateway] DBManager initialized.");
const configManager = new ConfigManager();
console.log("[TokenWall Gateway] ConfigManager initialized.");
const budgetEvaluator = new BudgetEvaluator(db, configManager);
const loopDetector = new RunawayLoopDetector(db);
const contextAnalyzer = new ContextAnalyzer();
const modelRouter = new ModelRouter();
const promptOptimizer = new PromptOptimizer();
const telemetryLogger = new TelemetryLogger(db);
console.log("[TokenWall Gateway] All engines ready. Starting server listen...");

// Admin API
server.get('/api/admin/sessions', async (request, reply) => {
  const sessions = telemetryLogger.getSessions(50);
  return reply.send(sessions);
});

server.get('/api/admin/events/:sessionId', async (request: any, reply) => {
  const { sessionId } = request.params;
  const events = telemetryLogger.reconstructTimeline(sessionId);
  return reply.send(events);
});

server.get('/api/admin/budgets', async (request, reply) => {
  const budgets = db.getBudgets(null);
  return reply.send(budgets);
});

server.get('/api/admin/summary', async (request, reply) => {
  const savings = db.getSavingsSummary();
  const workspaces = db.getWorkspaceUsage();
  const providers = db.getProviderUsage();
  const models = db.getModelUsage();
  
  const budgets = db.getBudgets(null);
  const daily = budgets.find(b => b.period === 'daily');
  const dailySpend = daily?.current_spend || 0;
  const dailyLimit = daily?.limit_amount || 0;

  return reply.send({
    dailySpend,
    dailyLimit,
    preventedSpend: savings.preventedSpend,
    optimizedSavings: savings.optimizedSavings,
    savedTokens: savings.savedTokens,
    workspaces,
    providers,
    models
  });
});

server.post('/api/admin/project/get-or-create', async (request: any, reply) => {
  const { name, path: dirPath } = request.body || {};
  if (!name || !dirPath) {
    return reply.status(400).send({ error: 'Missing name or path' });
  }
  const project = db.getOrCreateProject(name, dirPath);
  return reply.send(project);
});

const PORT = 1984;

// Intercept OpenAI Chat Completions
server.post('/v1/chat/completions', async (request, reply) => {
  const url = process.env.OPENAI_UPSTREAM_URL || 'https://api.openai.com/v1/chat/completions';
  return handleInterception('openai', url, request, reply);
});

// Intercept Anthropic Messages
server.post('/v1/messages', async (request, reply) => {
  const url = process.env.ANTHROPIC_UPSTREAM_URL || 'https://api.anthropic.com/v1/messages';
  return handleInterception('anthropic', url, request, reply);
});

// Intercept Gemini API
server.post('/v1/models/*', async (request, reply) => {
  const modelUrl = request.url;
  const baseUrl = process.env.GEMINI_UPSTREAM_URL || 'https://generativelanguage.googleapis.com';
  const targetUrl = `${baseUrl}${modelUrl}`;
  return handleInterception('gemini', targetUrl, request, reply);
});

server.post('/v1beta/models/*', async (request, reply) => {
  const modelUrl = request.url;
  const baseUrl = process.env.GEMINI_UPSTREAM_URL || 'https://generativelanguage.googleapis.com';
  const targetUrl = `${baseUrl}${modelUrl}`;
  return handleInterception('gemini', targetUrl, request, reply);
});

function countMessagesTokens(messages: any[], model: string): number {
  let total = 0;
  for (const m of messages) {
    if (m && m.content) {
      if (typeof m.content === 'string') {
        total += countTokens(m.content, model);
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            total += countTokens(block.text, model);
          }
        }
      }
    }
  }
  return total;
}

function countGeminiContentsTokens(contents: any[], model: string): number {
  let total = 0;
  for (const c of contents) {
    if (c && Array.isArray(c.parts)) {
      for (const p of c.parts) {
        if (p && typeof p.text === 'string') {
          total += countTokens(p.text, model);
        }
      }
    }
  }
  return total;
}

function getOptimizedMessages(
  originalMessages: any[],
  cleanMessages: any[],
  model: string,
  disableCodeCompression?: boolean
): any[] {
  if (!originalMessages) return originalMessages;
  const newMessages = JSON.parse(JSON.stringify(originalMessages));
  for (let i = 0; i < newMessages.length; i++) {
    const origMsg = newMessages[i];
    const cleanMsg = cleanMessages[i];
    if (!cleanMsg) continue;
    
    let newText = cleanMsg.content;
    try {
      if (cleanMsg.role === 'user' || cleanMsg.role === 'system') {
        const opt = promptOptimizer.optimize(newText, model, { disableCodeCompression });
        newText = opt.optimizedText;
      } else if (cleanMsg.role === 'tool') {
        newText = ToolPayloadCrusher.optimizeToolResult(newText, model);
      }
    } catch (e: any) {
      console.error("[TokenWall Gateway] Message optimization failed, falling open:", e.message);
      newText = cleanMsg.content; // fallback
    }

    if (typeof origMsg.content === 'string') {
      origMsg.content = newText;
    } else if (Array.isArray(origMsg.content)) {
      let firstTextBlock: any = null;
      let cacheControl: any = null;
      
      origMsg.content = origMsg.content.filter((b: any) => {
        if (b.type === 'text') {
          if (!firstTextBlock) firstTextBlock = b;
          if (b.cache_control) cacheControl = b.cache_control;
          return b === firstTextBlock; // Keep only the very first text block
        }
        return true; // Keep image/tool blocks
      });
      
      if (firstTextBlock) {
        firstTextBlock.text = newText;
        if (cacheControl && !firstTextBlock.cache_control) {
          firstTextBlock.cache_control = cacheControl;
        }
      } else if (newText) {
        origMsg.content.push({ type: 'text', text: newText });
      }
      
      // Anthropic tool_result payload crushing
      origMsg.content.forEach((b: any) => {
        if (b.type === 'tool_result') {
          if (typeof b.content === 'string') {
            try {
              b.content = ToolPayloadCrusher.optimizeToolResult(b.content, model);
            } catch (e) {
              console.error("[TokenWall Gateway] ToolPayload crushing failed, falling open");
            }
          } else if (Array.isArray(b.content)) {
            b.content.forEach((part: any) => {
              if (part.type === 'text' && typeof part.text === 'string') {
                try {
                  part.text = ToolPayloadCrusher.optimizeToolResult(part.text, model);
                } catch (e) {
                  console.error("[TokenWall Gateway] ToolPayload array part crushing failed, falling open");
                }
              }
            });
          }
        }
      });
    }
  }

  return newMessages;
}

function getOptimizedGeminiContents(
  originalContents: any[],
  cleanMessages: any[],
  model: string,
  disableCodeCompression?: boolean
): any[] {
  if (!originalContents) return originalContents;
  const newContents = JSON.parse(JSON.stringify(originalContents));
  for (let i = 0; i < newContents.length; i++) {
    const origContent = newContents[i];
    const cleanMsg = cleanMessages[i];
    if (!cleanMsg) continue;
    
    let newText = cleanMsg.content;
    if (cleanMsg.role === 'user' || cleanMsg.role === 'system') {
      try {
        const opt = promptOptimizer.optimize(newText, model, { disableCodeCompression });
        newText = opt.optimizedText;
      } catch (e: any) {
        console.error("[TokenWall Gateway] Gemini message optimization failed, falling open:", e.message);
        newText = cleanMsg.content;
      }
    }

    if (Array.isArray(origContent.parts)) {
      let firstTextPart: any = null;
      origContent.parts = origContent.parts.filter((p: any) => {
        if (typeof p.text === 'string') {
          if (!firstTextPart) firstTextPart = p;
          return p === firstTextPart;
        }
        return true;
      });
      if (firstTextPart) {
        firstTextPart.text = newText;
      } else if (newText) {
        origContent.parts.push({ text: newText });
      }
    }
  }

  return newContents;
}

function injectCCRTool(provider: string, body: any) {
  if (provider === 'openai') {
    if (!body.tools) body.tools = [];
    body.tools.push({
      type: 'function',
      function: {
        name: 'tokenwall_retrieve_content',
        description: 'Retrieves the original, untruncated content of a block that was compressed by TokenWall (e.g. lockfiles, large logs, or base64 data). Call this if you need to read the full content to answer the query.',
        parameters: {
          type: 'object',
          properties: {
            content_id: {
              type: 'string',
              description: 'The unique ID of the cached content block (e.g., ccr_lk_xxxx).'
            }
          },
          required: ['content_id']
        }
      }
    });
  } else if (provider === 'anthropic') {
    if (!body.tools) body.tools = [];
    body.tools.push({
      name: 'tokenwall_retrieve_content',
      description: 'Retrieves the original, untruncated content of a block that was compressed by TokenWall (e.g. lockfiles, large logs, or base64 data). Call this if you need to read the full content to answer the query.',
      input_schema: {
        type: 'object',
        properties: {
          content_id: {
            type: 'string',
            description: 'The unique ID of the cached content block (e.g., ccr_lk_xxxx).'
          }
        },
        required: ['content_id']
      }
    });
  } else if (provider === 'gemini') {
    if (!body.tools) body.tools = [];
    let toolObj = body.tools.find((t: any) => t.functionDeclarations);
    if (!toolObj) {
      toolObj = { functionDeclarations: [] };
      body.tools.push(toolObj);
    }
    toolObj.functionDeclarations.push({
      name: 'tokenwall_retrieve_content',
      description: 'Retrieves the original, untruncated content of a block that was compressed by TokenWall (e.g. lockfiles, large logs, or base64 data). Call this if you need to read the full content to answer the query.',
      parameters: {
        type: 'OBJECT',
        properties: {
          content_id: {
            type: 'STRING',
            description: 'The unique ID of the cached content block (e.g., ccr_lk_xxxx).'
          }
        },
        required: ['content_id']
      }
    });
  }
}

function injectSystemInstructions(provider: string, body: any, config: any, contextReport: any) {
  let instructions: string[] = [];
  if (config.verbositySteering !== false) {
    instructions.push("Be highly concise. Avoid explaining context, preambles, or restating unchanged files. Output only the requested edits or response directly.");
  }
  if (contextReport?.deduplicationsApplied && contextReport.deduplicationsApplied > 0) {
    instructions.push("TokenWall Optimization: To save context space, redundant file contents may be replaced with `[TokenWall: File identical to earlier occurrence. Refer to the chat history above for <path>]`. If you see this marker, DO NOT ask the user to provide the file. You already have the full file contents earlier in this conversation history. Scroll up to read it.");
  }

  if (instructions.length === 0) return;
  const steeringMsg = instructions.join("\n\n");
  if (provider === 'openai') {
    if (!body.messages) body.messages = [];
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    if (systemMsg) {
      systemMsg.content += `\n${steeringMsg}`;
    } else {
      body.messages.unshift({ role: 'system', content: steeringMsg });
    }
  } else if (provider === 'anthropic') {
    if (body.system) {
      if (typeof body.system === 'string') {
        body.system += `\n${steeringMsg}`;
      } else if (Array.isArray(body.system)) {
        body.system.push({ type: 'text', text: steeringMsg });
      }
    } else {
      body.system = steeringMsg;
    }
  } else if (provider === 'gemini') {
    if (body.systemInstruction) {
      if (!body.systemInstruction.parts) body.systemInstruction.parts = [];
      const textPart = body.systemInstruction.parts.find((p: any) => typeof p.text === 'string');
      if (textPart) {
        textPart.text += `\n${steeringMsg}`;
      } else {
        body.systemInstruction.parts.push({ text: steeringMsg });
      }
    } else {
      body.systemInstruction = { parts: [{ text: steeringMsg }] };
    }
  }
}

function injectAnthropicCacheControl(body: any) {
  // If the client (like Claude Code) natively uses prompt caching, do NOT interfere.
  // Anthropic has a strict limit of 4 cache_control blocks per request.
  if (JSON.stringify(body).includes('"cache_control"')) {
    return;
  }

  if (body.system) {
    if (typeof body.system === 'string') {
      body.system = [
        { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }
      ];
    } else if (Array.isArray(body.system) && body.system.length > 0) {
      const lastBlock = body.system[body.system.length - 1];
      if (typeof lastBlock === 'object') {
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1];
    if (typeof lastTool === 'object') {
      lastTool.cache_control = { type: 'ephemeral' };
    }
  }

  if (body.messages && Array.isArray(body.messages) && body.messages.length > 3) {
    const userMessages = body.messages.filter((m: any) => m.role === 'user');
    if (userMessages.length > 0) {
      const lastUserMsg = userMessages[userMessages.length - 1];
      if (lastUserMsg && lastUserMsg.content) {
        if (typeof lastUserMsg.content === 'string') {
          lastUserMsg.content = [
            { type: 'text', text: lastUserMsg.content, cache_control: { type: 'ephemeral' } }
          ];
        } else if (Array.isArray(lastUserMsg.content) && lastUserMsg.content.length > 0) {
          const lastBlock = lastUserMsg.content[lastUserMsg.content.length - 1];
          if (typeof lastBlock === 'object') {
            lastBlock.cache_control = { type: 'ephemeral' };
          }
        }
      }
    }
  }
}

async function executeUpstreamRequest(
  provider: 'openai' | 'anthropic' | 'gemini',
  targetUrl: string,
  headers: any,
  requestBody: any
): Promise<{ response: Response; resBody: any }> {
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    return { response, resBody: null };
  }

  const resBody = await response.json();

  let hasCCRToolCall = false;
  let contentId = '';
  let toolCallId = '';

  if (provider === 'openai') {
    const toolCall = resBody.choices?.[0]?.message?.tool_calls?.find((tc: any) => tc.function?.name === 'tokenwall_retrieve_content');
    if (toolCall) {
      hasCCRToolCall = true;
      toolCallId = toolCall.id;
      try {
        contentId = JSON.parse(toolCall.function.arguments).content_id;
      } catch {
        contentId = toolCall.function.arguments;
      }
    }
  } else if (provider === 'anthropic') {
    const toolUseBlock = resBody.content?.find((b: any) => b.type === 'tool_use' && b.name === 'tokenwall_retrieve_content');
    if (toolUseBlock) {
      hasCCRToolCall = true;
      toolCallId = toolUseBlock.id;
      contentId = toolUseBlock.input?.content_id;
    }
  } else if (provider === 'gemini') {
    const part = resBody.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall?.name === 'tokenwall_retrieve_content');
    if (part) {
      hasCCRToolCall = true;
      contentId = part.functionCall.args?.content_id;
    }
  }

  if (hasCCRToolCall) {
    console.log(`[CCR] Intercepted CCR tool call for content_id: ${contentId}`);
    const originalContent = db.getCachedContent(contentId) || "[Content not found in TokenWall cache]";

    if (provider === 'openai') {
      requestBody.messages.push(resBody.choices[0].message);
      requestBody.messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: 'tokenwall_retrieve_content',
        content: originalContent
      });
    } else if (provider === 'anthropic') {
      requestBody.messages.push({
        role: 'assistant',
        content: resBody.content
      });
      requestBody.messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: originalContent
        }]
      });
    } else if (provider === 'gemini') {
      requestBody.contents.push(resBody.candidates[0].content);
      requestBody.contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'tokenwall_retrieve_content',
            response: { content: originalContent }
          }
        }]
      });
    }

    return executeUpstreamRequest(provider, targetUrl, headers, requestBody);
  }

  return { response, resBody };
}

async function proxyStreamWithCCR(
  provider: 'openai' | 'anthropic' | 'gemini',
  targetUrl: string,
  headers: any,
  requestBody: any,
  requestId: string,
  sessionId: string,
  finalModel: string,
  estimation: any
): Promise<ReadableStream> {
  let inputAccumulated = 0;
  let outputAccumulated = 0;
  let streamFailed = false;
  let streamCancelled = false;

  return new ReadableStream({
    async start(controller) {
      async function runTurn(body: any): Promise<void> {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`Upstream error: ${response.status} - ${errorText}`);
          (err as any).statusCode = response.status;
          throw err;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Response body is not readable');
        }

        let isCCRToolCall = false;
        let ccrToolCallId = '';
        let ccrArgsAccumulator = '';
        let fullAssistantResponseForTurn: any = null;
        let assistantTextAccumulated = '';
        let assistantToolCallsAccumulated: any[] = [];
        let anthropicContentBlocks: any[] = [];

        const decoder = new TextDecoder();
        const parser = createParser({
          onEvent: (event: any) => {
            const parsedChunk = ProviderRegistry.parseStreamChunk(provider, event.data);
            if (parsedChunk?.usage) {
              if (parsedChunk.usage.inputTokens > 0) inputAccumulated = parsedChunk.usage.inputTokens;
              if (parsedChunk.usage.outputTokens > 0) outputAccumulated = parsedChunk.usage.outputTokens;
            }

            if (provider === 'openai') {
              try {
                const parsed = JSON.parse(event.data);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name === 'tokenwall_retrieve_content') {
                      isCCRToolCall = true;
                      ccrToolCallId = tc.id || ccrToolCallId;
                    }
                    let accTc = assistantToolCallsAccumulated.find(a => a.index === tc.index);
                    if (!accTc) {
                      accTc = { index: tc.index, id: tc.id, function: { name: tc.function?.name || '', arguments: '' } };
                      assistantToolCallsAccumulated.push(accTc);
                    }
                    if (tc.id) accTc.id = tc.id;
                    if (tc.function?.name) accTc.function.name = tc.function.name;
                    if (tc.function?.arguments) accTc.function.arguments += tc.function.arguments;
                  }
                }
                if (delta?.content) {
                  assistantTextAccumulated += delta.content;
                }
              } catch {}
            } else if (provider === 'anthropic') {
              try {
                const parsed = JSON.parse(event.data);
                if (parsed.type === 'content_block_start') {
                  const block = parsed.content_block;
                  if (block?.type === 'tool_use') {
                    if (block.name === 'tokenwall_retrieve_content') {
                      isCCRToolCall = true;
                      ccrToolCallId = parsed.message?.id || block.id;
                    }
                    anthropicContentBlocks[parsed.index] = {
                      type: 'tool_use',
                      id: block.id,
                      name: block.name,
                      input: {}
                    };
                  } else if (block?.type === 'text') {
                    anthropicContentBlocks[parsed.index] = {
                      type: 'text',
                      text: block.text || ''
                    };
                  }
                } else if (parsed.type === 'content_block_delta') {
                  const index = parsed.index;
                  const delta = parsed.delta;
                  if (delta?.type === 'text_delta') {
                    if (anthropicContentBlocks[index]) {
                      anthropicContentBlocks[index].text += delta.text;
                    }
                  } else if (delta?.type === 'input_json_delta') {
                    ccrArgsAccumulator += delta.partial_json || '';
                  }
                }
              } catch {}
            } else if (provider === 'gemini') {
              try {
                const parsed = JSON.parse(event.data);
                const part = parsed.candidates?.[0]?.content?.parts?.[0];
                if (part?.functionCall) {
                  if (part.functionCall.name === 'tokenwall_retrieve_content') {
                    isCCRToolCall = true;
                    ccrArgsAccumulator = JSON.stringify(part.functionCall.args);
                  }
                }
                fullAssistantResponseForTurn = parsed.candidates?.[0]?.content;
              } catch {}
            }
          }
        });

        const bufferChunks: Uint8Array[] = [];

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunkText = decoder.decode(value, { stream: true });
            parser.feed(chunkText);
            bufferChunks.push(value);
          }
        } catch (err) {
          streamFailed = true;
          throw err;
        }

        if (isCCRToolCall) {
          let contentId = '';
          if (provider === 'openai') {
            const ccrCall = assistantToolCallsAccumulated.find(tc => tc.function.name === 'tokenwall_retrieve_content');
            if (ccrCall) {
              try {
                contentId = JSON.parse(ccrCall.function.arguments).content_id;
              } catch {
                contentId = ccrCall.function.arguments;
              }
              ccrToolCallId = ccrCall.id;
            }
          } else if (provider === 'anthropic') {
            try {
              contentId = JSON.parse(ccrArgsAccumulator).content_id;
            } catch {
              contentId = ccrArgsAccumulator;
            }
          } else if (provider === 'gemini') {
            try {
              contentId = JSON.parse(ccrArgsAccumulator).content_id;
            } catch {
              contentId = ccrArgsAccumulator;
            }
          }

          console.log(`[Stream CCR] Resolving content_id: ${contentId} in request ${requestId}`);
          const originalContent = db.getCachedContent(contentId) || "[Content not found in TokenWall cache]";

          if (provider === 'openai') {
            body.messages.push({
              role: 'assistant',
              content: assistantTextAccumulated || null,
              tool_calls: assistantToolCallsAccumulated.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments
                }
              }))
            });
            body.messages.push({
              role: 'tool',
              tool_call_id: ccrToolCallId,
              name: 'tokenwall_retrieve_content',
              content: originalContent
            });
          } else if (provider === 'anthropic') {
            const ccrBlockIndex = anthropicContentBlocks.findIndex(b => b.type === 'tool_use' && b.name === 'tokenwall_retrieve_content');
            if (ccrBlockIndex !== -1) {
              try {
                anthropicContentBlocks[ccrBlockIndex].input = JSON.parse(ccrArgsAccumulator);
              } catch {
                anthropicContentBlocks[ccrBlockIndex].input = { content_id: contentId };
              }
            }
            body.messages.push({
              role: 'assistant',
              content: anthropicContentBlocks
            });
            body.messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: ccrToolCallId || 'ccr_id',
                content: originalContent
              }]
            });
          } else if (provider === 'gemini') {
            if (fullAssistantResponseForTurn) {
              body.contents.push(fullAssistantResponseForTurn);
            }
            body.contents.push({
              role: 'user',
              parts: [{
                functionResponse: {
                  name: 'tokenwall_retrieve_content',
                  response: { content: originalContent }
                }
              }]
            });
          }

          return runTurn(body);
        } else {
          for (const chunk of bufferChunks) {
            controller.enqueue(chunk);
          }
        }
      }

      try {
        await runTurn(requestBody);
        telemetryLogger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId });
        controller.close();
      } catch (err: any) {
        streamFailed = true;
        telemetryLogger.emitEvent({ eventType: 'provider_stream_interrupted', sessionId, requestId, metadata: { error: err?.message } });
        controller.error(err);
      } finally {
        if (inputAccumulated === 0) inputAccumulated = estimation.estimatedInputTokens;
        if (outputAccumulated === 0) outputAccumulated = estimation.estimatedOutputTokens;

        const pricing = getPricingForModel(finalModel);
        const finalCost = ((inputAccumulated / 1000000) * pricing.inputPerMillion) + 
                          ((outputAccumulated / 1000000) * pricing.outputPerMillion);

        telemetryLogger.emitEvent({ eventType: 'provider_usage_received', sessionId, requestId, metadata: { usage: { inputTokens: inputAccumulated, outputTokens: outputAccumulated } } });
        db.updateRequestTokens(requestId, inputAccumulated, outputAccumulated);
        
        const status = streamFailed ? 'failed' : 'success';
        const state = streamFailed ? 'failed' : (streamCancelled ? 'cancelled' : 'reconciled');
        
        telemetryLogger.reconcileRequest(requestId, finalCost, status, state);
        telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state, finalCost } });
      }
    },
    cancel() {
      streamCancelled = true;
      telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
      if (inputAccumulated === 0) inputAccumulated = estimation.estimatedInputTokens;
      db.updateRequestTokens(requestId, inputAccumulated, outputAccumulated || 1);
      telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'cancelled');
      telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'cancelled' } });
    }
  });
}

async function handleInterception(
  provider: 'openai' | 'anthropic' | 'gemini',
  targetUrl: string,
  request: any,
  reply: any
) {
  // Defensive check: If body wasn't parsed as JSON (e.g. missing Content-Type header), parse it now.
  if (typeof request.body === 'string') {
    try {
      request.body = JSON.parse(request.body);
    } catch (e) {
      reply.status(400).send({ error: { message: "Invalid JSON payload received by TokenWall." } });
      return;
    }
  }

  const sessionId = request.headers['x-tokenwall-session-id'] || 'default-session';
  const projectId = request.headers['x-tokenwall-project-id'] || null;

  // Make sure session exists
  const session = db.getSession(sessionId);
  if (!session) {
    db.createSession(sessionId, projectId, configManager.getConfig().sessionLimit);
  }

  // Generate Request ID early so we can track events
  const requestId = Math.random().toString(36).substring(2, 11);

  telemetryLogger.emitEvent({
    eventType: 'request_received',
    sessionId,
    requestId,
    provider,
    metadata: { url: targetUrl }
  });

  // Parse into common NormalizedRequest
  const parsedRequest = ProviderRegistry.parseRequest(provider, request.body, request.url);

  // Pre-flight validation
  const estimation = calculatePreFlightEstimation(parsedRequest);
  const config = configManager.getConfig();
  const isKillSwitchActive = process.env.TOKENWALL_KILL_SWITCH === 'true';

  let contextReport: any = { inefficiencies: [], cleanMessages: parsedRequest.messages };
  let routingOptions: any = { shouldRoute: false, alternatives: [] };

  if (!isKillSwitchActive) {
    try {
      contextReport = await contextAnalyzer.analyze(parsedRequest, config);
    } catch (err: any) {
      console.error("[TokenWall Gateway] ContextAnalyzer failed, falling open:", err.message);
      telemetryLogger.emitEvent({ eventType: 'pipeline_error', sessionId, requestId, metadata: { stage: 'ContextAnalyzer', error: err.message } });
    }
    
    try {
      routingOptions = modelRouter.generateRoutingOptions(parsedRequest, estimation.estimatedInputTokens, estimation.estimatedOutputTokens);
    } catch (err: any) {
      console.error("[TokenWall Gateway] ModelRouter failed, falling open:", err.message);
      telemetryLogger.emitEvent({ eventType: 'pipeline_error', sessionId, requestId, metadata: { stage: 'ModelRouter', error: err.message } });
    }
  }
  
  // We need hasEditTools early for attribution missed opportunities
  const hasEditTools = request.body.tools && request.body.tools.some((t: any) => 
    ['replace_file_content', 'insert_at_line', 'edit_file', 'write_to_file', 'apply_diff'].includes(t?.function?.name)
  );
  
  let attribution: any = null;
  let categorySavings: Record<string, number> = {};

  try {
    attribution = TokenAttributionAnalyzer.analyze(parsedRequest);
    categorySavings = {
      'JSON crushing': 0,
      'Log pruning': 0,
      'Tool pruning': 0,
      'Context deduplication': 0,
      'Code compression': 0,
    };

    for (const ineff of contextReport.inefficiencies) {
      if (ineff.type === 'lockfile' || ineff.type === 'json') categorySavings['JSON crushing'] += ineff.approximateTokens;
      else if (ineff.type === 'logs') categorySavings['Log pruning'] += ineff.approximateTokens;
      else if (ineff.type === 'duplicate') categorySavings['Context deduplication'] += ineff.approximateTokens;
      else if (ineff.type === 'code') categorySavings['Code compression'] += ineff.approximateTokens;
    }

    telemetryLogger.emitEvent({
      eventType: 'attribution_calculated',
      sessionId,
      requestId,
      metadata: { 
        attribution, 
        categorySavings, 
        clientHeader: request.headers['x-tokenwall-client'] || request.headers['user-agent'] || 'unknown'
      }
    });

    console.log('\n--- ADVANCED TOKEN ATTRIBUTION REPORT ---');
    console.log('Composition');
    
    const pct = (val: number) => ((val / (attribution.totalTokens || 1)) * 100).toFixed(0).padStart(2, ' ');
    console.log(`Source code               ${attribution.sourceCodeTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.sourceCodeTokens)}%)`);
    console.log(`Logs                      ${attribution.logsTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.logsTokens)}%)`);
    console.log(`Tool schemas              ${attribution.toolSchemasTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.toolSchemasTokens)}%)`);
    console.log(`JSON payloads             ${attribution.jsonPayloadsTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.jsonPayloadsTokens)}%)`);
    console.log(`Conversation              ${attribution.conversationTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.conversationTokens)}%)`);
    console.log(`System prompt             ${attribution.systemPromptTokens.toLocaleString().padStart(6, ' ')} tokens (${pct(attribution.systemPromptTokens)}%)`);
    
    console.log('\nSankey Pipeline');
    let runningTotal = attribution.totalTokens;
    console.log(`Incoming\n${runningTotal.toLocaleString()}\n↓`);
    
    let hasOpts = false;
    // Sort optimizations by tokens saved
    const sortedOpts = Object.entries(categorySavings).sort((a, b) => b[1] - a[1]);
    for (const [name, saved] of sortedOpts) {
      if (saved > 0) {
         runningTotal -= saved;
         const roiPct = ((saved / (attribution.totalTokens || 1)) * 100);
         const stars = roiPct >= 15 ? '★★★★★' : roiPct >= 10 ? '★★★★☆' : roiPct >= 5 ? '★★★☆☆' : roiPct >= 2 ? '★★☆☆☆' : '★☆☆☆☆';
         console.log(`${name.padEnd(20)} -${saved.toLocaleString()} tokens (${stars})\n${runningTotal.toLocaleString()}\n↓`);
         hasOpts = true;
      }
    }
    
    if (!hasOpts) {
      console.log('No optimizers triggered.\n↓');
    }
    console.log(`Output\n${runningTotal.toLocaleString()}`);
    
    console.log('\nLargest remaining opportunity:');
    const remain = [
      { name: 'Source code', count: Math.max(0, attribution.sourceCodeTokens - categorySavings['Code compression']), reason: hasEditTools ? 'Write-path safety bypass' : null },
      { name: 'Logs', count: Math.max(0, attribution.logsTokens - categorySavings['Log pruning']), reason: null },
      { name: 'JSON payloads', count: Math.max(0, attribution.jsonPayloadsTokens - categorySavings['JSON crushing']), reason: null },
      { name: 'Tool schemas', count: Math.max(0, attribution.toolSchemasTokens - categorySavings['Tool pruning']), reason: 'Tool pruning currently inactive' },
      { name: 'Conversation', count: Math.max(0, attribution.conversationTokens), reason: 'Agent intent preservation' }
    ].sort((a, b) => b.count - a.count);
    
    const topOpportunity = remain[0];
    console.log(topOpportunity.name);
    console.log(`${topOpportunity.count.toLocaleString()} tokens`);
    console.log(`Optimizable          ${topOpportunity.reason ? 'NO' : 'YES'}`);
    if (topOpportunity.reason) {
      console.log(`Reason               ${topOpportunity.reason}`);
    } else {
      console.log(`Potential savings    ~50%`);
    }
    console.log('--------------------------------\n');
  } catch (err: any) {
    console.error("[TokenWall Gateway] Attribution report failed:", err.message);
  }
  
  // Prompt Optimization (heuristic compression preview)
  const userMessages = parsedRequest.messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1];
  

  // We apply prompt optimizer to ALL user messages in getOptimizedMessages later.
  // For telemetry/preview purposes, we just run it on the last user message to see if there's any immediate savings.
  let optimization: any = undefined;
  if (!isKillSwitchActive) {
    try {
      optimization = lastUserMsg
        ? promptOptimizer.optimize(lastUserMsg.content, parsedRequest.model, { disableCodeCompression: hasEditTools })
        : undefined;
    } catch (err: any) {
      console.error("[TokenWall Gateway] PromptOptimizer preview failed, falling open:", err.message);
    }
  }

  // Run loop detector
  const loopCheck = loopDetector.detect(sessionId, lastUserMsg ? lastUserMsg.content : '', estimation.estimatedInputTokens);
  if (loopCheck.loopDetected) {
    telemetryLogger.emitEvent({
      eventType: 'runaway_loop_detected',
      sessionId,
      requestId,
      provider,
      model: parsedRequest.model,
      metadata: { reason: loopCheck.reason }
    });
    const savingsId = Math.random().toString(36).substring(2, 11);
    db.logSavingsEvent({
      id: savingsId,
      sessionId,
      requestId,
      type: 'block_runaway',
      amount: estimation.estimatedCost,
      tokens: estimation.estimatedInputTokens + estimation.estimatedOutputTokens
    });
    TerminalUI.drawBlockedAlert(loopCheck.reason || 'Runaway loop detected');
    telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'failed'); // using generated requestId instead of dummy
    return sendBlockedResponse(
      reply,
      provider,
      400,
      loopCheck.reason || 'Runaway loop detected',
      'runaway_loop_detected',
      'too_many_requests'
    );
  }

  // Run budget evaluation (Transactional Reservation)
  let budgetCheck: any = { allowed: true, warnOnly: false };
  if (!isKillSwitchActive) {
    try {
      budgetCheck = budgetEvaluator.evaluate(projectId, sessionId, requestId, estimation.estimatedCost, parsedRequest.provider, parsedRequest.model);
    } catch (err: any) {
      console.error("[TokenWall Gateway] BudgetEvaluator failed, falling open:", err.message);
      telemetryLogger.emitEvent({ eventType: 'pipeline_error', sessionId, requestId, metadata: { stage: 'BudgetEvaluator', error: err.message } });
    }
  }

  if (!budgetCheck.allowed) {
    telemetryLogger.emitEvent({
      eventType: 'budget_limit_exceeded',
      sessionId,
      requestId,
      provider,
      model: parsedRequest.model,
      metadata: { reason: budgetCheck.blockedReason, estimatedCost: estimation.estimatedCost }
    });
    const savingsId = Math.random().toString(36).substring(2, 11);
    db.logSavingsEvent({
      id: savingsId,
      sessionId,
      requestId,
      type: 'block_budget',
      amount: estimation.estimatedCost,
      tokens: estimation.estimatedInputTokens + estimation.estimatedOutputTokens
    });
    TerminalUI.drawBlockedAlert(budgetCheck.blockedReason || 'Budget Exceeded');
    return sendBlockedResponse(
      reply,
      provider,
      403,
      budgetCheck.blockedReason || 'Budget Exceeded',
      'budget_exceeded',
      'payment_required'
    );
  } else {
    telemetryLogger.emitEvent({
      eventType: 'reservation_created',
      sessionId,
      requestId,
      provider,
      model: parsedRequest.model,
      metadata: { estimatedCost: estimation.estimatedCost }
    });
  }

  // Determine if we show interactive warning
  let action: 'approve' | 'optimize' | 'switch_model' | 'cancel' = 'approve';
  let chosenModel: string | undefined = undefined;
  
  const hasCostWarning = estimation.estimatedCost >= (config.autoApproveLimit ?? 0.05);
  const hasBudgetWarning = budgetCheck.warnOnly;
  const hasRoutingWarning = routingOptions.shouldRoute;
  const hasContextInefficiencies = contextReport.inefficiencies.length > 0;

  let needsWarning = hasCostWarning || hasBudgetWarning || hasRoutingWarning || hasContextInefficiencies;

  // Auto-Optimize Bypass: if autoOptimize is enabled and the only warning is context inefficiencies,
  // we automatically optimize without warning the user/blocking via Control Plane.
  if (config.autoOptimize && hasContextInefficiencies && !hasCostWarning && !hasBudgetWarning && !hasRoutingWarning) {
    action = 'optimize';
    needsWarning = false;
  }
  
  if (needsWarning) {
    telemetryLogger.emitEvent({
      eventType: 'approval_requested',
      sessionId,
      requestId,
      provider,
      model: parsedRequest.model,
      metadata: { estimatedCost: estimation.estimatedCost, warnings: contextReport.inefficiencies.length }
    });

    const configSettings = configManager.getConfig();
    const isHeadless = configSettings.headless || process.env.TOKENWALL_HEADLESS === 'true';
    if (isHeadless) {
      // Headless policy evaluation
      if (routingOptions.shouldRoute && configSettings.routingPolicy?.autoSwitchBelowThreshold && estimation.estimatedCost < configSettings.routingPolicy.autoSwitchBelowThreshold) {
        // Auto-switch to the cheapest alternative if below threshold
        const sortedAlts = [...routingOptions.alternatives].sort((a, b) => a.estimatedCost - b.estimatedCost);
        if (sortedAlts.length > 0) {
           action = 'switch_model';
           chosenModel = sortedAlts[0].model;
           telemetryLogger.emitEvent({ eventType: 'policy_triggered', sessionId, requestId, metadata: { policy: 'auto_switch', chosenModel } });
        } else {
           action = 'approve';
        }
      } else if (configSettings.autoApproveLimit && estimation.estimatedCost <= configSettings.autoApproveLimit) {
        action = 'approve';
        telemetryLogger.emitEvent({ eventType: 'auto_approved', sessionId, requestId, metadata: { limit: configSettings.autoApproveLimit } });
      } else if (configSettings.autoDenyLimit && estimation.estimatedCost >= configSettings.autoDenyLimit) {
        action = 'cancel';
        telemetryLogger.emitEvent({ eventType: 'auto_denied', sessionId, requestId, metadata: { limit: configSettings.autoDenyLimit } });
      } else {
        // Fallback in headless mode: block if it requires approval but is outside auto-approve bounds
        action = 'cancel';
        telemetryLogger.emitEvent({ eventType: 'auto_denied', sessionId, requestId, metadata: { reason: 'outside_auto_approve_bounds' } });
      }
    } else {
      // Interactive mode via Control Plane
      const result = await controlPlane.requestApproval({
        requestId,
        projectId,
        sessionId,
        model: parsedRequest.model,
        estimatedCost: estimation.estimatedCost,
        warnings: contextReport.inefficiencies,
        routingAlternatives: routingOptions.alternatives
      });

      // Check if the client disconnected while we were waiting for approval
      const isDisconnected = request.raw.aborted || request.raw.socket.destroyed;

      if (isDisconnected) {
        telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
        telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'cancelled');
        return sendBlockedResponse(
          reply,
          provider,
          499,
          'Client disconnected during approval.',
          'client_disconnected',
          'client_closed_request'
        );
      }

      action = result.action;
      chosenModel = result.chosenModel;

      if (action === 'cancel') {
        telemetryLogger.emitEvent({ eventType: 'approval_denied', sessionId, requestId });
      } else {
        telemetryLogger.emitEvent({ eventType: 'approval_granted', sessionId, requestId, metadata: { action, chosenModel } });
      }
    }
  }

  if (action === 'cancel') {
    telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
    telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'cancelled');
    return sendBlockedResponse(
      reply,
      provider,
      400,
      'Request cancelled by user in TokenWall.',
      'cancelled_by_user',
      'forbidden'
    );
  }

  let finalRequestBody = request.body;
  let finalRequest = parsedRequest;
  let savedTokens = 0;

  if (action === 'optimize') {
    const cleanMsgs = contextReport.cleanMessages;
    const lastUserIdx = cleanMsgs.map((m: any) => m.role).lastIndexOf('user');
    
    // Re-serialize back to provider schema while preserving non-text blocks
    if (provider === 'openai' || provider === 'anthropic') {
      finalRequestBody = {
        ...request.body,
        messages: getOptimizedMessages(request.body.messages, cleanMsgs, parsedRequest.model, hasEditTools)
      };
      
      // Optimize top-level Anthropic system prompt
      if (provider === 'anthropic' && finalRequestBody.system) {
        if (typeof finalRequestBody.system === 'string') {
          finalRequestBody.system = promptOptimizer.optimize(finalRequestBody.system, parsedRequest.model, { disableCodeCompression: hasEditTools }).optimizedText;
        } else if (Array.isArray(finalRequestBody.system)) {
          finalRequestBody.system = finalRequestBody.system.map((block: any) => {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              return {
                ...block,
                text: promptOptimizer.optimize(block.text, parsedRequest.model, { disableCodeCompression: hasEditTools }).optimizedText
              };
            }
            return block;
          });
        }
      }
    } else if (provider === 'gemini') {
      finalRequestBody = {
        ...request.body,
        contents: getOptimizedGeminiContents(request.body.contents, cleanMsgs, parsedRequest.model, hasEditTools)
      };
      
      // Optimize top-level Gemini systemInstruction
      if (finalRequestBody.systemInstruction && Array.isArray(finalRequestBody.systemInstruction.parts)) {
        finalRequestBody.systemInstruction.parts = finalRequestBody.systemInstruction.parts.map((part: any) => {
          if (part && typeof part.text === 'string') {
            return {
              ...part,
              text: promptOptimizer.optimize(part.text, parsedRequest.model, { disableCodeCompression: hasEditTools }).optimizedText
            };
          }
          return part;
        });
      }
    }
    finalRequest = { ...parsedRequest, messages: cleanMsgs };
    
    // Parse the fully optimized body back into a NormalizedRequest to count its exact tokens
    finalRequest = ProviderRegistry.parseRequest(provider, finalRequestBody, targetUrl);
    
    // Optimize tool schemas and expose tools via routing if tools are present
    if (finalRequestBody.tools && Array.isArray(finalRequestBody.tools) && finalRequestBody.tools.length > 0) {
      try {
        finalRequestBody.tools = ToolRouter.route(finalRequestBody.tools, finalRequest.messages);
        finalRequestBody.tools = ToolSchemaOptimizer.optimize(finalRequestBody.tools, false); // false = conservative mode
        // Re-parse to count final token savings accurately
        finalRequest = ProviderRegistry.parseRequest(provider, finalRequestBody, targetUrl);
      } catch (err: any) {
        console.error("[TokenWall Gateway] Tool optimization failed, falling open:", err.message);
        // Tool array might be corrupted if it failed halfway, so we can try to fall back to the original
        finalRequestBody.tools = request.body.tools;
        finalRequest = ProviderRegistry.parseRequest(provider, finalRequestBody, targetUrl);
      }
    }
    
    const optimizedEstimation = calculatePreFlightEstimation(finalRequest);
    savedTokens = Math.max(0, estimation.estimatedInputTokens - optimizedEstimation.estimatedInputTokens);
    
    console.log(c.green(`✔ Applied Prompt Optimization (Estimated savings: ${savedTokens} tokens)`));
    
    // Save CCR cached contents if any
    if (contextReport.cachedContents && contextReport.cachedContents.length > 0) {
      for (const cc of contextReport.cachedContents) {
        db.saveCachedContent(cc.id, requestId, cc.content);
      }
      if (config.reversibleCompression !== false) {
        injectCCRTool(provider, finalRequestBody);
      }
    }

    const pricing = getPricingForModel(parsedRequest.model);
    const savingsAmount = (savedTokens / 1000000) * pricing.inputPerMillion;
    const savingsId = Math.random().toString(36).substring(2, 11);
    db.logSavingsEvent({
      id: savingsId,
      sessionId,
      requestId,
      type: 'optimize_prompt',
      amount: savingsAmount,
      tokens: savedTokens
    });

    // Write log for optimized request including the full body (top-level system prompts)
    try {
      const logDir = path.join(os.homedir(), '.tokenwall', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'latest_optimized_request.json');

      const unoptimizedTokens = estimation.estimatedInputTokens;
      const optimizedTokens = optimizedEstimation.estimatedInputTokens;
      const pct = unoptimizedTokens > 0 ? Math.round((savedTokens / unoptimizedTokens) * 100) : 0;

      const logStructure = {
        unoptimized: {
          total_tokens: unoptimizedTokens,
          payload: request.body
        },
        optimized: {
          total_tokens: optimizedTokens,
          payload: finalRequestBody
        },
        summary: {
          tokens_saved: savedTokens,
          savings_percent: `${pct}%`
        }
      };

      fs.writeFileSync(logPath, JSON.stringify(logStructure, null, 2), 'utf8');
      console.log(c.magenta(`[TokenWall] Saved full optimized request payload to ${logPath} for inspection.`));
    } catch (err) {
      console.log(c.yellow(`[TokenWall] Failed to save optimized request log.`));
    }
  } else if (action === 'switch_model') {
    const recommendedModel = chosenModel || (routingOptions.alternatives.length > 0 ? routingOptions.alternatives[0].model : parsedRequest.model);
    if (provider === 'openai' || provider === 'anthropic') {
      finalRequestBody = {
        ...request.body,
        model: recommendedModel
      };
    } else if (provider === 'gemini') {
      // Gemini models are specified in the URL path, so we update the target URL instead
      targetUrl = targetUrl.replace(parsedRequest.model, recommendedModel);
    }
    finalRequest = { ...parsedRequest, model: recommendedModel };
    console.log(c.green(`✔ Switched model to: ${recommendedModel}`));
    db.updateRequestRouting(requestId, parsedRequest.model, 'switched_model');
    const altPricing = getPricingForModel(recommendedModel);
    const originalCost = estimation.estimatedCost;
    const newCost = (estimation.estimatedInputTokens / 1000000) * altPricing.inputPerMillion + (estimation.estimatedOutputTokens / 1000000) * altPricing.outputPerMillion;
    const savingsAmount = Math.max(0, originalCost - newCost);
    const savingsId = Math.random().toString(36).substring(2, 11);
    db.logSavingsEvent({
      id: savingsId,
      sessionId,
      requestId,
      type: 'switch_model',
      amount: savingsAmount,
      tokens: 0
    });
  }

  // Apply System Prompt Optimization Instructions
  injectSystemInstructions(provider, finalRequestBody, config, contextReport);

  // Apply Anthropic Caching Breakpoints
  if (provider === 'anthropic' && config.cacheAlignment !== false) {
    injectAnthropicCacheControl(finalRequestBody);
  }

  // Mutate OpenAI Request to include stream_options if streaming
  if (provider === 'openai' && parsedRequest.stream) {
    finalRequestBody = {
      ...finalRequestBody,
      stream_options: { include_usage: true }
    };
  }

  // Forward request headers
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection' && key.toLowerCase() !== 'content-length') {
      forwardHeaders[key] = value as string;
    }
  }

  // Forward payload to destination API
  telemetryLogger.emitEvent({ eventType: 'provider_request_sent', sessionId, requestId, provider, model: finalRequest.model });
  try {
    if (!parsedRequest.stream) {
      // Non-streaming response handling with CCR recursive check
      const { response: upstreamRes, resBody } = await executeUpstreamRequest(
        provider,
        targetUrl,
        forwardHeaders,
        finalRequestBody
      );

      if (!upstreamRes.ok) {
        const errorText = await upstreamRes.text();
        telemetryLogger.emitEvent({ eventType: 'request_stream_failed', sessionId, requestId, provider, model: finalRequest.model, metadata: { error: errorText } });
        telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'failed');
        telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'failed' } });
        return reply.status(upstreamRes.status).send(errorText);
      }

      // Set response headers
      for (const [key, value] of upstreamRes.headers.entries()) {
        reply.header(key, value);
      }

      const normalizedRes = ProviderRegistry.parseResponse(provider, resBody);
      
      const pricing = getPricingForModel(finalRequest.model);
      const totalCost = ((normalizedRes.usage.inputTokens / 1000000) * pricing.inputPerMillion) + 
                        ((normalizedRes.usage.outputTokens / 1000000) * pricing.outputPerMillion);
      
      telemetryLogger.emitEvent({ eventType: 'provider_usage_received', sessionId, requestId, metadata: { usage: normalizedRes.usage } });
      telemetryLogger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId });
      
      db.updateRequestTokens(requestId, normalizedRes.usage.inputTokens, normalizedRes.usage.outputTokens);
      telemetryLogger.reconcileRequest(requestId, totalCost, 'success', 'reconciled');
      telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'reconciled', finalCost: totalCost } });
      
      return reply.send(resBody);
    }

    // Streaming Response proxy with CCR recursive check
    telemetryLogger.emitEvent({ eventType: 'provider_stream_started', sessionId, requestId, provider, model: finalRequest.model });
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    reply.header('connection', 'keep-alive');

    const stream = await proxyStreamWithCCR(
      provider,
      targetUrl,
      forwardHeaders,
      finalRequestBody,
      requestId,
      sessionId,
      finalRequest.model,
      estimation
    );

    return reply.send(stream);
  } catch (error: any) {
    const isUpstreamError = error?.message && error.message.includes('Upstream error:');
    if (!isUpstreamError && (request.raw.aborted || request.raw.socket.destroyed)) {
      console.log('Client aborted request stream mid-flight.');
      telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
      telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'cancelled');
      return;
    }
    console.error('Error forwarding request:', error);
    telemetryLogger.emitEvent({ eventType: 'request_stream_failed', sessionId, requestId, metadata: { error: error?.message } });
    telemetryLogger.reconcileRequest(requestId, 0, 'failed', 'failed');
    telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'failed' } });
    const status = error?.statusCode || 500;
    return reply.status(status).send({ error: { message: error?.message || 'Unknown error' } });
  }
}

function sendBlockedResponse(
  reply: any,
  provider: 'openai' | 'anthropic' | 'gemini',
  statusCode: number,
  message: string,
  errorType: string,
  errorCode: string
) {
  // Notify the VS Code extension control plane
  controlPlane.sendNotification(`TokenWall Blocked: ${message}`, statusCode >= 429 ? 'warning' : 'error');

  if (provider === 'anthropic') {
    return reply.status(statusCode).send({
      type: 'error',
      error: {
        type: (errorType === 'runaway_loop_detected' || errorType === 'invalid_request_error') ? 'invalid_request_error' : 'permission_error',
        message: `TokenWall blocked request: ${message}`
      }
    });
  }

  if (provider === 'gemini') {
    return reply.status(statusCode).send({
      error: {
        code: statusCode,
        message: `TokenWall blocked request: ${message}`,
        status: errorType === 'runaway_loop_detected' ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED'
      }
    });
  }

  // Default to OpenAI format
  return reply.status(statusCode).send({
    error: {
      message: `TokenWall blocked request: ${message}`,
      type: errorType,
      code: errorCode
    }
  });
}

// Start gateway server
server.listen({ port: PORT, host: '127.0.0.1' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  // Reconcile any stale reservations from previous crashes
  db.reconcileStaleReservations();
  TerminalUI.drawGatewayStartup(PORT);
});
