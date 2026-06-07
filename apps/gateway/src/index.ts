import fastify from 'fastify';
import { DBManager, ConfigManager } from '@tokenwall/core';
import { ProviderRegistry, NormalizedRequest, NormalizedResponse } from '@tokenwall/providers';
import { calculatePreFlightEstimation, getPricingForModel } from '@tokenwall/estimators';
import { BudgetEvaluator, RunawayLoopDetector } from '@tokenwall/budget-engine';
import { ContextAnalyzer } from '@tokenwall/context-engine';
import { ModelRouter } from '@tokenwall/routing-engine';
import { PromptOptimizer } from '@tokenwall/prompt-optimizer';
import { TelemetryLogger } from '@tokenwall/telemetry';
import { TerminalUI, c } from '@tokenwall/terminal-ui';
import { createParser } from 'eventsource-parser';

const server = fastify({ logger: false });

const db = new DBManager();
const configManager = new ConfigManager();
const budgetEvaluator = new BudgetEvaluator(db, configManager);
const loopDetector = new RunawayLoopDetector(db);
const contextAnalyzer = new ContextAnalyzer();
const modelRouter = new ModelRouter();
const promptOptimizer = new PromptOptimizer();
const telemetryLogger = new TelemetryLogger(db);

const PORT = 1984;

// Intercept OpenAI Chat Completions
server.post('/v1/chat/completions', async (request, reply) => {
  return handleInterception('openai', 'https://api.openai.com/v1/chat/completions', request, reply);
});

// Intercept Anthropic Messages
server.post('/v1/messages', async (request, reply) => {
  return handleInterception('anthropic', 'https://api.anthropic.com/v1/messages', request, reply);
});

// Intercept Gemini API
server.post('/v1/models/*', async (request, reply) => {
  const modelUrl = request.url;
  const targetUrl = `https://generativelanguage.googleapis.com${modelUrl}`;
  return handleInterception('gemini', targetUrl, request, reply);
});

server.post('/v1beta/models/*', async (request, reply) => {
  const modelUrl = request.url;
  const targetUrl = `https://generativelanguage.googleapis.com${modelUrl}`;
  return handleInterception('gemini', targetUrl, request, reply);
});

async function handleInterception(
  provider: 'openai' | 'anthropic' | 'gemini',
  targetUrl: string,
  request: any,
  reply: any
) {
  const sessionId = request.headers['x-tokenwall-session-id'] || 'default-session';
  const projectId = request.headers['x-tokenwall-project-id'] || null;

  // Make sure session exists
  const session = db.getSession(sessionId);
  if (!session) {
    db.createSession(sessionId, projectId, configManager.getConfig().sessionLimit);
  }

  // Parse into common NormalizedRequest
  const parsedRequest = ProviderRegistry.parseRequest(provider, request.body, request.url);

  // Pre-flight validation
  const estimation = calculatePreFlightEstimation(parsedRequest);
  const contextReport = contextAnalyzer.analyze(parsedRequest);
  const routingRecommendation = modelRouter.recommendRoute(parsedRequest, estimation.estimatedInputTokens, estimation.estimatedOutputTokens);
  
  // Prompt Optimization (heuristic compression preview)
  const firstUserMsg = parsedRequest.messages.find(m => m.role === 'user');
  const optimization = firstUserMsg
    ? promptOptimizer.optimize(firstUserMsg.content, parsedRequest.model)
    : undefined;

  // Run loop detector
  const loopCheck = loopDetector.detect(sessionId, firstUserMsg ? firstUserMsg.content : '', estimation.estimatedInputTokens);
  if (loopCheck.loopDetected) {
    TerminalUI.drawBlockedAlert(loopCheck.reason || 'Runaway loop detected');
    telemetryLogger.reconcileRequest('dummy', 0, 'blocked', 'failed');
    return reply.status(429).send({
      error: {
        message: `TokenWall blocked request: ${loopCheck.reason}`,
        type: 'runaway_loop_detected',
        code: 'too_many_requests'
      }
    });
  }

  // Generate Request ID
  const requestId = Math.random().toString(36).substring(2, 11);

  // Run budget evaluation (Transactional Reservation)
  const budgetCheck = budgetEvaluator.evaluate(projectId, sessionId, requestId, estimation.estimatedCost, parsedRequest.provider, parsedRequest.model);

  if (!budgetCheck.allowed) {
    TerminalUI.drawBlockedAlert(budgetCheck.blockedReason || 'Budget Exceeded');
    // It was never reserved, so no reconciliation needed for the reservation itself, but we can log it.
    // Actually evaluate() reserves if allowed, but rejects if not. So no reservation exists.
    return reply.status(402).send({
      error: {
        message: `TokenWall blocked request: ${budgetCheck.blockedReason}`,
        type: 'budget_exceeded',
        code: 'payment_required'
      }
    });
  }

  // Determine if we show interactive warning
  let action: 'approve' | 'optimize' | 'switch_model' | 'cancel' = 'approve';
  const needsWarning = estimation.estimatedCost >= 0.05 || budgetCheck.warnOnly || contextReport.inefficiencies.length > 0;
  
  if (needsWarning) {
    action = await TerminalUI.askApproval(estimation.estimatedCost.toFixed(4), parsedRequest.model);
  }

  if (action === 'cancel') {
    telemetryLogger.reconcileRequest(requestId, 0, 'blocked', 'cancelled');
    return reply.status(402).send({
      error: {
        message: 'Request cancelled by user in TokenWall.',
        type: 'cancelled_by_user'
      }
    });
  }

  let finalRequestBody = request.body;
  let finalRequest = parsedRequest;
  let savedTokens = 0;

  if (action === 'optimize') {
    // Replace payload messages with optimized cleanMessages
    const cleanMsgs = contextReport.cleanMessages;
    
    // Apply heuristic prompt rewrite to the last user message
    const lastUserIdx = cleanMsgs.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx !== -1 && optimization) {
      cleanMsgs[lastUserIdx].content = optimization.optimizedText;
      savedTokens += optimization.tokensSaved;
    }
    
    savedTokens += contextReport.totalWasteTokens;

    // Re-serialize back to provider schema
    if (provider === 'openai' || provider === 'anthropic') {
      finalRequestBody = {
        ...request.body,
        messages: cleanMsgs.map(m => ({ role: m.role, content: m.content }))
      };
    } else if (provider === 'gemini') {
      finalRequestBody = {
        ...request.body,
        contents: cleanMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }))
      };
    }
    finalRequest = { ...parsedRequest, messages: cleanMsgs };
    console.log(c.green(`✔ Applied Prompt Optimization (Estimated savings: ${savedTokens} tokens)`));
  } else if (action === 'switch_model') {
    const recommendedModel = routingRecommendation.recommendedModel;
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
    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection') {
      forwardHeaders[key] = value as string;
    }
  }

  // Forward payload to destination API
  let streamReconciled = false;
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(finalRequestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'failed');
      streamReconciled = true;
      return reply.status(response.status).send(errorText);
    }

    // Set response headers
    for (const [key, value] of response.headers.entries()) {
      reply.header(key, value);
    }

    if (!parsedRequest.stream) {
      // Non-streaming response
      const resBody = await response.json();
      const normalizedRes = ProviderRegistry.parseResponse(provider, resBody);
      
      const pricing = getPricingForModel(finalRequest.model);
      const totalCost = ((normalizedRes.usage.inputTokens / 1000000) * pricing.inputPerMillion) + 
                        ((normalizedRes.usage.outputTokens / 1000000) * pricing.outputPerMillion);
      
      db.updateRequestTokens(requestId, normalizedRes.usage.inputTokens, normalizedRes.usage.outputTokens);
      telemetryLogger.reconcileRequest(requestId, totalCost, 'success', 'reconciled');
      streamReconciled = true;
      
      return reply.send(resBody);
    }

    // Streaming Response proxy
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    reply.header('connection', 'keep-alive');

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    let inputAccumulated = 0;
    let outputAccumulated = 0;
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Robust SSE Parser
        const parser = createParser({
          onEvent: (event: any) => {
            const parsedChunk = ProviderRegistry.parseStreamChunk(provider, event.data);
            if (parsedChunk && parsedChunk.usage) {
              if (parsedChunk.usage.inputTokens > 0) inputAccumulated = parsedChunk.usage.inputTokens;
              if (parsedChunk.usage.outputTokens > 0) outputAccumulated = parsedChunk.usage.outputTokens;
            }
          }
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            controller.enqueue(value);
            const chunkText = decoder.decode(value, { stream: true });
            parser.feed(chunkText);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          // Stream ended, cancelled, or errored: Reconcile!
          if (inputAccumulated === 0) inputAccumulated = estimation.estimatedInputTokens;
          if (outputAccumulated === 0) outputAccumulated = estimation.estimatedOutputTokens; // fallback

          const pricing = getPricingForModel(finalRequest.model);
          const finalCost = ((inputAccumulated / 1000000) * pricing.inputPerMillion) + 
                            ((outputAccumulated / 1000000) * pricing.outputPerMillion);

          db.updateRequestTokens(requestId, inputAccumulated, outputAccumulated);
          telemetryLogger.reconcileRequest(requestId, finalCost, 'success', 'reconciled');
          streamReconciled = true;
        }
      },
      cancel() {
        reader.cancel();
      }
    });

    return reply.send(stream);
  } catch (error: any) {
    console.error('Error forwarding request:', error);
    if (!streamReconciled) {
       telemetryLogger.reconcileRequest(requestId, 0, 'failed', 'failed');
    }
    return reply.status(500).send({ error: { message: error.message } });
  }
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
