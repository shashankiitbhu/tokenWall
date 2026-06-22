"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const core_1 = require("@tokenwall/core");
const providers_1 = require("@tokenwall/providers");
const estimators_1 = require("@tokenwall/estimators");
const budget_engine_1 = require("@tokenwall/budget-engine");
const context_engine_1 = require("@tokenwall/context-engine");
const routing_engine_1 = require("@tokenwall/routing-engine");
const prompt_optimizer_1 = require("@tokenwall/prompt-optimizer");
const telemetry_1 = require("@tokenwall/telemetry");
const terminal_ui_1 = require("@tokenwall/terminal-ui");
const eventsource_parser_1 = require("eventsource-parser");
const websocket_1 = __importDefault(require("@fastify/websocket"));
const cors_1 = __importDefault(require("@fastify/cors"));
const static_1 = __importDefault(require("@fastify/static"));
const path_1 = __importDefault(require("path"));
const control_plane_js_1 = require("./control-plane.js");
const server = (0, fastify_1.default)({ logger: false });
server.register(cors_1.default, { origin: '*' });
server.register(websocket_1.default);
const getDashboardPath = () => {
    const devPath = path_1.default.join(__dirname, '../../dashboard/dist');
    if (fs_1.default.existsSync(devPath))
        return devPath;
    const prodPath = path_1.default.join(__dirname, '../dashboard');
    if (fs_1.default.existsSync(prodPath))
        return prodPath;
    const cliProdPath = path_1.default.join(__dirname, '../dashboard/dist');
    if (fs_1.default.existsSync(cliProdPath))
        return cliProdPath;
    return devPath; // Fallback
};
server.register(static_1.default, {
    root: getDashboardPath(),
    prefix: '/dashboard/',
});
server.register(async function (f) {
    control_plane_js_1.controlPlane.registerWebsocket(f);
});
console.log("[TokenWall Gateway] Initializing components...");
const db = new core_1.DBManager();
console.log("[TokenWall Gateway] DBManager initialized.");
const configManager = new core_1.ConfigManager();
console.log("[TokenWall Gateway] ConfigManager initialized.");
const budgetEvaluator = new budget_engine_1.BudgetEvaluator(db, configManager);
const loopDetector = new budget_engine_1.RunawayLoopDetector(db);
const contextAnalyzer = new context_engine_1.ContextAnalyzer();
const modelRouter = new routing_engine_1.ModelRouter();
const promptOptimizer = new prompt_optimizer_1.PromptOptimizer();
const telemetryLogger = new telemetry_1.TelemetryLogger(db);
console.log("[TokenWall Gateway] All engines ready. Starting server listen...");
// Admin API
server.get('/api/admin/sessions', async (request, reply) => {
    const sessions = telemetryLogger.getSessions(50);
    return reply.send(sessions);
});
server.get('/api/admin/events/:sessionId', async (request, reply) => {
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
server.post('/api/admin/project/get-or-create', async (request, reply) => {
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
function countMessagesTokens(messages, model) {
    let total = 0;
    for (const m of messages) {
        if (m && m.content) {
            if (typeof m.content === 'string') {
                total += (0, estimators_1.countTokens)(m.content, model);
            }
            else if (Array.isArray(m.content)) {
                for (const block of m.content) {
                    if (block && block.type === 'text' && typeof block.text === 'string') {
                        total += (0, estimators_1.countTokens)(block.text, model);
                    }
                }
            }
        }
    }
    return total;
}
function countGeminiContentsTokens(contents, model) {
    let total = 0;
    for (const c of contents) {
        if (c && Array.isArray(c.parts)) {
            for (const p of c.parts) {
                if (p && typeof p.text === 'string') {
                    total += (0, estimators_1.countTokens)(p.text, model);
                }
            }
        }
    }
    return total;
}
function getOptimizedMessages(originalMessages, cleanMessages, model) {
    if (!originalMessages)
        return originalMessages;
    const newMessages = JSON.parse(JSON.stringify(originalMessages));
    for (let i = 0; i < newMessages.length; i++) {
        const origMsg = newMessages[i];
        const cleanMsg = cleanMessages[i];
        if (!cleanMsg)
            continue;
        let newText = cleanMsg.content;
        if (cleanMsg.role === 'user' || cleanMsg.role === 'system') {
            const opt = promptOptimizer.optimize(newText, model);
            newText = opt.optimizedText;
        }
        if (typeof origMsg.content === 'string') {
            origMsg.content = newText;
        }
        else if (Array.isArray(origMsg.content)) {
            let firstTextBlock = null;
            let cacheControl = null;
            origMsg.content = origMsg.content.filter((b) => {
                if (b.type === 'text') {
                    if (!firstTextBlock)
                        firstTextBlock = b;
                    if (b.cache_control)
                        cacheControl = b.cache_control;
                    return b === firstTextBlock; // Keep only the very first text block
                }
                return true; // Keep image/tool blocks
            });
            if (firstTextBlock) {
                firstTextBlock.text = newText;
                if (cacheControl && !firstTextBlock.cache_control) {
                    firstTextBlock.cache_control = cacheControl;
                }
            }
            else if (newText) {
                origMsg.content.push({ type: 'text', text: newText });
            }
        }
    }
    return newMessages;
}
function getOptimizedGeminiContents(originalContents, cleanMessages, model) {
    if (!originalContents)
        return originalContents;
    const newContents = JSON.parse(JSON.stringify(originalContents));
    for (let i = 0; i < newContents.length; i++) {
        const origContent = newContents[i];
        const cleanMsg = cleanMessages[i];
        if (!cleanMsg)
            continue;
        let newText = cleanMsg.content;
        if (cleanMsg.role === 'user' || cleanMsg.role === 'system') {
            const opt = promptOptimizer.optimize(newText, model);
            newText = opt.optimizedText;
        }
        if (Array.isArray(origContent.parts)) {
            let firstTextPart = null;
            origContent.parts = origContent.parts.filter((p) => {
                if (typeof p.text === 'string') {
                    if (!firstTextPart)
                        firstTextPart = p;
                    return p === firstTextPart;
                }
                return true;
            });
            if (firstTextPart) {
                firstTextPart.text = newText;
            }
            else if (newText) {
                origContent.parts.push({ text: newText });
            }
        }
    }
    return newContents;
}
function injectCCRTool(provider, body) {
    if (provider === 'openai') {
        if (!body.tools)
            body.tools = [];
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
    }
    else if (provider === 'anthropic') {
        if (!body.tools)
            body.tools = [];
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
    }
    else if (provider === 'gemini') {
        if (!body.tools)
            body.tools = [];
        let toolObj = body.tools.find((t) => t.functionDeclarations);
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
function injectVerbositySteering(provider, body) {
    const steeringMsg = "Be highly concise. Avoid explaining context, preambles, or restating unchanged files. Output only the requested edits or response directly.";
    if (provider === 'openai') {
        if (!body.messages)
            body.messages = [];
        const systemMsg = body.messages.find((m) => m.role === 'system');
        if (systemMsg) {
            systemMsg.content += `\n${steeringMsg}`;
        }
        else {
            body.messages.unshift({ role: 'system', content: steeringMsg });
        }
    }
    else if (provider === 'anthropic') {
        if (body.system) {
            if (typeof body.system === 'string') {
                body.system += `\n${steeringMsg}`;
            }
            else if (Array.isArray(body.system)) {
                body.system.push({ type: 'text', text: steeringMsg });
            }
        }
        else {
            body.system = steeringMsg;
        }
    }
    else if (provider === 'gemini') {
        if (body.systemInstruction) {
            if (!body.systemInstruction.parts)
                body.systemInstruction.parts = [];
            const textPart = body.systemInstruction.parts.find((p) => typeof p.text === 'string');
            if (textPart) {
                textPart.text += `\n${steeringMsg}`;
            }
            else {
                body.systemInstruction.parts.push({ text: steeringMsg });
            }
        }
        else {
            body.systemInstruction = { parts: [{ text: steeringMsg }] };
        }
    }
}
function injectAnthropicCacheControl(body) {
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
        }
        else if (Array.isArray(body.system) && body.system.length > 0) {
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
        const userMessages = body.messages.filter((m) => m.role === 'user');
        if (userMessages.length > 0) {
            const lastUserMsg = userMessages[userMessages.length - 1];
            if (lastUserMsg && lastUserMsg.content) {
                if (typeof lastUserMsg.content === 'string') {
                    lastUserMsg.content = [
                        { type: 'text', text: lastUserMsg.content, cache_control: { type: 'ephemeral' } }
                    ];
                }
                else if (Array.isArray(lastUserMsg.content) && lastUserMsg.content.length > 0) {
                    const lastBlock = lastUserMsg.content[lastUserMsg.content.length - 1];
                    if (typeof lastBlock === 'object') {
                        lastBlock.cache_control = { type: 'ephemeral' };
                    }
                }
            }
        }
    }
}
async function executeUpstreamRequest(provider, targetUrl, headers, requestBody) {
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
        const toolCall = resBody.choices?.[0]?.message?.tool_calls?.find((tc) => tc.function?.name === 'tokenwall_retrieve_content');
        if (toolCall) {
            hasCCRToolCall = true;
            toolCallId = toolCall.id;
            try {
                contentId = JSON.parse(toolCall.function.arguments).content_id;
            }
            catch {
                contentId = toolCall.function.arguments;
            }
        }
    }
    else if (provider === 'anthropic') {
        const toolUseBlock = resBody.content?.find((b) => b.type === 'tool_use' && b.name === 'tokenwall_retrieve_content');
        if (toolUseBlock) {
            hasCCRToolCall = true;
            toolCallId = toolUseBlock.id;
            contentId = toolUseBlock.input?.content_id;
        }
    }
    else if (provider === 'gemini') {
        const part = resBody.candidates?.[0]?.content?.parts?.find((p) => p.functionCall?.name === 'tokenwall_retrieve_content');
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
        }
        else if (provider === 'anthropic') {
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
        }
        else if (provider === 'gemini') {
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
async function proxyStreamWithCCR(provider, targetUrl, headers, requestBody, requestId, sessionId, finalModel, estimation) {
    let inputAccumulated = 0;
    let outputAccumulated = 0;
    let streamFailed = false;
    let streamCancelled = false;
    return new ReadableStream({
        async start(controller) {
            async function runTurn(body) {
                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body)
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    const err = new Error(`Upstream error: ${response.status} - ${errorText}`);
                    err.statusCode = response.status;
                    throw err;
                }
                const reader = response.body?.getReader();
                if (!reader) {
                    throw new Error('Response body is not readable');
                }
                let isCCRToolCall = false;
                let ccrToolCallId = '';
                let ccrArgsAccumulator = '';
                let fullAssistantResponseForTurn = null;
                let assistantTextAccumulated = '';
                let assistantToolCallsAccumulated = [];
                let anthropicContentBlocks = [];
                const decoder = new TextDecoder();
                const parser = (0, eventsource_parser_1.createParser)({
                    onEvent: (event) => {
                        const parsedChunk = providers_1.ProviderRegistry.parseStreamChunk(provider, event.data);
                        if (parsedChunk?.usage) {
                            if (parsedChunk.usage.inputTokens > 0)
                                inputAccumulated = parsedChunk.usage.inputTokens;
                            if (parsedChunk.usage.outputTokens > 0)
                                outputAccumulated = parsedChunk.usage.outputTokens;
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
                                        if (tc.id)
                                            accTc.id = tc.id;
                                        if (tc.function?.name)
                                            accTc.function.name = tc.function.name;
                                        if (tc.function?.arguments)
                                            accTc.function.arguments += tc.function.arguments;
                                    }
                                }
                                if (delta?.content) {
                                    assistantTextAccumulated += delta.content;
                                }
                            }
                            catch { }
                        }
                        else if (provider === 'anthropic') {
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
                                    }
                                    else if (block?.type === 'text') {
                                        anthropicContentBlocks[parsed.index] = {
                                            type: 'text',
                                            text: block.text || ''
                                        };
                                    }
                                }
                                else if (parsed.type === 'content_block_delta') {
                                    const index = parsed.index;
                                    const delta = parsed.delta;
                                    if (delta?.type === 'text_delta') {
                                        if (anthropicContentBlocks[index]) {
                                            anthropicContentBlocks[index].text += delta.text;
                                        }
                                    }
                                    else if (delta?.type === 'input_json_delta') {
                                        ccrArgsAccumulator += delta.partial_json || '';
                                    }
                                }
                            }
                            catch { }
                        }
                        else if (provider === 'gemini') {
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
                            }
                            catch { }
                        }
                    }
                });
                const bufferChunks = [];
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
                }
                catch (err) {
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
                            }
                            catch {
                                contentId = ccrCall.function.arguments;
                            }
                            ccrToolCallId = ccrCall.id;
                        }
                    }
                    else if (provider === 'anthropic') {
                        try {
                            contentId = JSON.parse(ccrArgsAccumulator).content_id;
                        }
                        catch {
                            contentId = ccrArgsAccumulator;
                        }
                    }
                    else if (provider === 'gemini') {
                        try {
                            contentId = JSON.parse(ccrArgsAccumulator).content_id;
                        }
                        catch {
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
                    }
                    else if (provider === 'anthropic') {
                        const ccrBlockIndex = anthropicContentBlocks.findIndex(b => b.type === 'tool_use' && b.name === 'tokenwall_retrieve_content');
                        if (ccrBlockIndex !== -1) {
                            try {
                                anthropicContentBlocks[ccrBlockIndex].input = JSON.parse(ccrArgsAccumulator);
                            }
                            catch {
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
                    }
                    else if (provider === 'gemini') {
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
                }
                else {
                    for (const chunk of bufferChunks) {
                        controller.enqueue(chunk);
                    }
                }
            }
            try {
                await runTurn(requestBody);
                telemetryLogger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId });
                controller.close();
            }
            catch (err) {
                streamFailed = true;
                telemetryLogger.emitEvent({ eventType: 'provider_stream_interrupted', sessionId, requestId, metadata: { error: err?.message } });
                controller.error(err);
            }
            finally {
                if (inputAccumulated === 0)
                    inputAccumulated = estimation.estimatedInputTokens;
                if (outputAccumulated === 0)
                    outputAccumulated = estimation.estimatedOutputTokens;
                const pricing = (0, estimators_1.getPricingForModel)(finalModel);
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
            if (inputAccumulated === 0)
                inputAccumulated = estimation.estimatedInputTokens;
            db.updateRequestTokens(requestId, inputAccumulated, outputAccumulated || 1);
            telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'cancelled');
            telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'cancelled' } });
        }
    });
}
async function handleInterception(provider, targetUrl, request, reply) {
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
    const parsedRequest = providers_1.ProviderRegistry.parseRequest(provider, request.body, request.url);
    // Pre-flight validation
    const estimation = (0, estimators_1.calculatePreFlightEstimation)(parsedRequest);
    const config = configManager.getConfig();
    const contextReport = await contextAnalyzer.analyze(parsedRequest, config);
    const routingOptions = modelRouter.generateRoutingOptions(parsedRequest, estimation.estimatedInputTokens, estimation.estimatedOutputTokens);
    // Prompt Optimization (heuristic compression preview)
    const userMessages = parsedRequest.messages.filter(m => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    // We apply prompt optimizer to ALL user messages in getOptimizedMessages later.
    // For telemetry/preview purposes, we just run it on the last user message to see if there's any immediate savings.
    const optimization = lastUserMsg
        ? promptOptimizer.optimize(lastUserMsg.content, parsedRequest.model)
        : undefined;
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
        terminal_ui_1.TerminalUI.drawBlockedAlert(loopCheck.reason || 'Runaway loop detected');
        telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'failed'); // using generated requestId instead of dummy
        return sendBlockedResponse(reply, provider, 400, loopCheck.reason || 'Runaway loop detected', 'runaway_loop_detected', 'too_many_requests');
    }
    // Run budget evaluation (Transactional Reservation)
    const budgetCheck = budgetEvaluator.evaluate(projectId, sessionId, requestId, estimation.estimatedCost, parsedRequest.provider, parsedRequest.model);
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
        terminal_ui_1.TerminalUI.drawBlockedAlert(budgetCheck.blockedReason || 'Budget Exceeded');
        return sendBlockedResponse(reply, provider, 403, budgetCheck.blockedReason || 'Budget Exceeded', 'budget_exceeded', 'payment_required');
    }
    else {
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
    let action = 'approve';
    let chosenModel = undefined;
    const hasCostWarning = estimation.estimatedCost >= 0.05;
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
                }
                else {
                    action = 'approve';
                }
            }
            else if (configSettings.autoApproveLimit && estimation.estimatedCost <= configSettings.autoApproveLimit) {
                action = 'approve';
                telemetryLogger.emitEvent({ eventType: 'auto_approved', sessionId, requestId, metadata: { limit: configSettings.autoApproveLimit } });
            }
            else if (configSettings.autoDenyLimit && estimation.estimatedCost >= configSettings.autoDenyLimit) {
                action = 'cancel';
                telemetryLogger.emitEvent({ eventType: 'auto_denied', sessionId, requestId, metadata: { limit: configSettings.autoDenyLimit } });
            }
            else {
                // Fallback in headless mode: block if it requires approval but is outside auto-approve bounds
                action = 'cancel';
                telemetryLogger.emitEvent({ eventType: 'auto_denied', sessionId, requestId, metadata: { reason: 'outside_auto_approve_bounds' } });
            }
        }
        else {
            // Interactive mode via Control Plane
            const result = await control_plane_js_1.controlPlane.requestApproval({
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
                return sendBlockedResponse(reply, provider, 499, 'Client disconnected during approval.', 'client_disconnected', 'client_closed_request');
            }
            action = result.action;
            chosenModel = result.chosenModel;
            if (action === 'cancel') {
                telemetryLogger.emitEvent({ eventType: 'approval_denied', sessionId, requestId });
            }
            else {
                telemetryLogger.emitEvent({ eventType: 'approval_granted', sessionId, requestId, metadata: { action, chosenModel } });
            }
        }
    }
    if (action === 'cancel') {
        telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
        telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'cancelled');
        return sendBlockedResponse(reply, provider, 400, 'Request cancelled by user in TokenWall.', 'cancelled_by_user', 'forbidden');
    }
    let finalRequestBody = request.body;
    let finalRequest = parsedRequest;
    let savedTokens = 0;
    if (action === 'optimize') {
        const cleanMsgs = contextReport.cleanMessages;
        const lastUserIdx = cleanMsgs.map(m => m.role).lastIndexOf('user');
        // Re-serialize back to provider schema while preserving non-text blocks
        if (provider === 'openai' || provider === 'anthropic') {
            finalRequestBody = {
                ...request.body,
                messages: getOptimizedMessages(request.body.messages, cleanMsgs, parsedRequest.model)
            };
            // Optimize top-level Anthropic system prompt
            if (provider === 'anthropic' && finalRequestBody.system) {
                if (typeof finalRequestBody.system === 'string') {
                    finalRequestBody.system = promptOptimizer.optimize(finalRequestBody.system, parsedRequest.model).optimizedText;
                }
                else if (Array.isArray(finalRequestBody.system)) {
                    finalRequestBody.system = finalRequestBody.system.map((block) => {
                        if (block && block.type === 'text' && typeof block.text === 'string') {
                            return {
                                ...block,
                                text: promptOptimizer.optimize(block.text, parsedRequest.model).optimizedText
                            };
                        }
                        return block;
                    });
                }
            }
        }
        else if (provider === 'gemini') {
            finalRequestBody = {
                ...request.body,
                contents: getOptimizedGeminiContents(request.body.contents, cleanMsgs, parsedRequest.model)
            };
            // Optimize top-level Gemini systemInstruction
            if (finalRequestBody.systemInstruction && Array.isArray(finalRequestBody.systemInstruction.parts)) {
                finalRequestBody.systemInstruction.parts = finalRequestBody.systemInstruction.parts.map((part) => {
                    if (part && typeof part.text === 'string') {
                        return {
                            ...part,
                            text: promptOptimizer.optimize(part.text, parsedRequest.model).optimizedText
                        };
                    }
                    return part;
                });
            }
        }
        // Parse the fully optimized body back into a NormalizedRequest to count its exact tokens
        finalRequest = providers_1.ProviderRegistry.parseRequest(provider, finalRequestBody, targetUrl);
        const optimizedEstimation = (0, estimators_1.calculatePreFlightEstimation)(finalRequest);
        savedTokens = Math.max(0, estimation.estimatedInputTokens - optimizedEstimation.estimatedInputTokens);
        console.log(terminal_ui_1.c.green(`✔ Applied Prompt Optimization (Estimated savings: ${savedTokens} tokens)`));
        // Save CCR cached contents if any
        if (contextReport.cachedContents && contextReport.cachedContents.length > 0) {
            for (const cc of contextReport.cachedContents) {
                db.saveCachedContent(cc.id, requestId, cc.content);
            }
            if (config.reversibleCompression !== false) {
                injectCCRTool(provider, finalRequestBody);
            }
        }
        const pricing = (0, estimators_1.getPricingForModel)(parsedRequest.model);
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
            const logDir = path_1.default.join(os_1.default.homedir(), '.tokenwall', 'logs');
            if (!fs_1.default.existsSync(logDir))
                fs_1.default.mkdirSync(logDir, { recursive: true });
            const logPath = path_1.default.join(logDir, 'latest_optimized_request.json');
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
            fs_1.default.writeFileSync(logPath, JSON.stringify(logStructure, null, 2), 'utf8');
            console.log(terminal_ui_1.c.magenta(`[TokenWall] Saved full optimized request payload to ${logPath} for inspection.`));
        }
        catch (err) {
            console.log(terminal_ui_1.c.yellow(`[TokenWall] Failed to save optimized request log.`));
        }
    }
    else if (action === 'switch_model') {
        const recommendedModel = chosenModel || (routingOptions.alternatives.length > 0 ? routingOptions.alternatives[0].model : parsedRequest.model);
        if (provider === 'openai' || provider === 'anthropic') {
            finalRequestBody = {
                ...request.body,
                model: recommendedModel
            };
        }
        else if (provider === 'gemini') {
            // Gemini models are specified in the URL path, so we update the target URL instead
            targetUrl = targetUrl.replace(parsedRequest.model, recommendedModel);
        }
        finalRequest = { ...parsedRequest, model: recommendedModel };
        console.log(terminal_ui_1.c.green(`✔ Switched model to: ${recommendedModel}`));
        db.updateRequestRouting(requestId, parsedRequest.model, 'switched_model');
        const altPricing = (0, estimators_1.getPricingForModel)(recommendedModel);
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
    // Apply Output Token Reduction (Verbosity Steering)
    if (config.verbositySteering !== false) {
        injectVerbositySteering(provider, finalRequestBody);
    }
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
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(request.headers)) {
        if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection' && key.toLowerCase() !== 'content-length') {
            forwardHeaders[key] = value;
        }
    }
    // Forward payload to destination API
    telemetryLogger.emitEvent({ eventType: 'provider_request_sent', sessionId, requestId, provider, model: finalRequest.model });
    try {
        if (!parsedRequest.stream) {
            // Non-streaming response handling with CCR recursive check
            const { response: upstreamRes, resBody } = await executeUpstreamRequest(provider, targetUrl, forwardHeaders, finalRequestBody);
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
            const normalizedRes = providers_1.ProviderRegistry.parseResponse(provider, resBody);
            const pricing = (0, estimators_1.getPricingForModel)(finalRequest.model);
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
        const stream = await proxyStreamWithCCR(provider, targetUrl, forwardHeaders, finalRequestBody, requestId, sessionId, finalRequest.model, estimation);
        return reply.send(stream);
    }
    catch (error) {
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
function sendBlockedResponse(reply, provider, statusCode, message, errorType, errorCode) {
    // Notify the VS Code extension control plane
    control_plane_js_1.controlPlane.sendNotification(`TokenWall Blocked: ${message}`, statusCode >= 429 ? 'warning' : 'error');
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
    terminal_ui_1.TerminalUI.drawGatewayStartup(PORT);
});
