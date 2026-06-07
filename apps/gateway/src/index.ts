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
import fastifyWebsocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { controlPlane } from './control-plane.js';

const server = fastify({ logger: false });
server.register(cors as any, { origin: '*' });
server.register(fastifyWebsocket as any);
server.register(async function (f) {
  controlPlane.registerWebsocket(f);
});

const db = new DBManager();
const configManager = new ConfigManager();
const budgetEvaluator = new BudgetEvaluator(db, configManager);
const loopDetector = new RunawayLoopDetector(db);
const contextAnalyzer = new ContextAnalyzer();
const modelRouter = new ModelRouter();
const promptOptimizer = new PromptOptimizer();
const telemetryLogger = new TelemetryLogger(db);

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
  const contextReport = contextAnalyzer.analyze(parsedRequest);
  const routingOptions = modelRouter.generateRoutingOptions(parsedRequest, estimation.estimatedInputTokens, estimation.estimatedOutputTokens);
  
  // Prompt Optimization (heuristic compression preview)
  const firstUserMsg = parsedRequest.messages.find(m => m.role === 'user');
  const optimization = firstUserMsg
    ? promptOptimizer.optimize(firstUserMsg.content, parsedRequest.model)
    : undefined;

  // Run loop detector
  const loopCheck = loopDetector.detect(sessionId, firstUserMsg ? firstUserMsg.content : '', estimation.estimatedInputTokens);
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
  
  const needsWarning = estimation.estimatedCost >= 0.05 || budgetCheck.warnOnly || contextReport.inefficiencies.length > 0 || routingOptions.shouldRoute;
  
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
      403,
      'Request cancelled by user in TokenWall.',
      'cancelled_by_user',
      'forbidden'
    );
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
  let streamReconciled = false;
  telemetryLogger.emitEvent({ eventType: 'provider_request_sent', sessionId, requestId, provider, model: finalRequest.model });
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(finalRequestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      telemetryLogger.emitEvent({ eventType: 'request_stream_failed', sessionId, requestId, provider, model: finalRequest.model, metadata: { error: errorText } });
      telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'failed');
      telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'failed' } });
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
      
      telemetryLogger.emitEvent({ eventType: 'provider_usage_received', sessionId, requestId, metadata: { usage: normalizedRes.usage } });
      telemetryLogger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId });
      
      db.updateRequestTokens(requestId, normalizedRes.usage.inputTokens, normalizedRes.usage.outputTokens);
      telemetryLogger.reconcileRequest(requestId, totalCost, 'success', 'reconciled');
      telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'reconciled', finalCost: totalCost } });
      streamReconciled = true;
      
      return reply.send(resBody);
    }

    // Streaming Response proxy
    telemetryLogger.emitEvent({ eventType: 'provider_stream_started', sessionId, requestId, provider, model: finalRequest.model });
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    reply.header('connection', 'keep-alive');

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    let inputAccumulated = 0;
    let outputAccumulated = 0;
    let streamFailed = false;
    let streamCancelled = false;
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Robust SSE Parser
        const parser = createParser({
          onEvent: (event: any) => {
            const parsedChunk = ProviderRegistry.parseStreamChunk(provider, event.data);
            if (parsedChunk) {
              if (parsedChunk.text && parsedChunk.text.startsWith('[Tool Use:')) {
                console.log(`[Stream] [Tool Use] ${parsedChunk.text} detected for request ${requestId}`);
                const match = parsedChunk.text.match(/\[Tool Use:\s*([^\]]+)\]/);
                if (match) {
                  const toolName = match[1];
                  const toolCallId = Math.random().toString(36).substring(2, 11);
                  db.logToolCall(toolCallId, requestId, toolName, parsedChunk.text.length);
                }
              }
              if (parsedChunk.usage) {
                if (parsedChunk.usage.inputTokens > 0) {
                  inputAccumulated = parsedChunk.usage.inputTokens;
                  console.log(`[Stream] [Input Usage] Intercepted message_start usage inputTokens=${inputAccumulated} for request ${requestId}`);
                }
                if (parsedChunk.usage.outputTokens > 0) {
                  outputAccumulated = parsedChunk.usage.outputTokens;
                  console.log(`[Stream] [Output Usage] Intercepted message_delta usage outputTokens=${outputAccumulated} for request ${requestId}`);
                }
              }
            }
          }
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              telemetryLogger.emitEvent({ eventType: 'request_stream_completed', sessionId, requestId });
              controller.close();
              break;
            }
            controller.enqueue(value);
            const chunkText = decoder.decode(value, { stream: true });
            parser.feed(chunkText);
          }
        } catch (err: any) {
          streamFailed = true;
          telemetryLogger.emitEvent({ eventType: 'provider_stream_interrupted', sessionId, requestId, metadata: { error: err?.message } });
          controller.error(err);
        } finally {
          if (!streamReconciled) {
            if (inputAccumulated === 0) inputAccumulated = estimation.estimatedInputTokens;
            if (outputAccumulated === 0) outputAccumulated = estimation.estimatedOutputTokens; // fallback

            const pricing = getPricingForModel(finalRequest.model);
            const finalCost = ((inputAccumulated / 1000000) * pricing.inputPerMillion) + 
                              ((outputAccumulated / 1000000) * pricing.outputPerMillion);

            telemetryLogger.emitEvent({ eventType: 'provider_usage_received', sessionId, requestId, metadata: { usage: { inputTokens: inputAccumulated, outputTokens: outputAccumulated } } });

            db.updateRequestTokens(requestId, inputAccumulated, outputAccumulated);
            
            const status = streamFailed ? 'failed' : 'success';
            const state = streamFailed ? 'failed' : (streamCancelled ? 'cancelled' : 'reconciled');
            
            telemetryLogger.reconcileRequest(requestId, finalCost, status, state);
            telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state, finalCost } });
            
            console.log(`[Reconcile] Request ${requestId} resolved: state=${state}, cost=$${finalCost.toFixed(6)}, input=${inputAccumulated}, output=${outputAccumulated}`);
            streamReconciled = true;
          }
        }
      },
      cancel() {
        streamCancelled = true;
        telemetryLogger.emitEvent({ eventType: 'request_stream_cancelled', sessionId, requestId });
        reader.cancel();
        
        if (!streamReconciled) {
          db.updateRequestTokens(requestId, inputAccumulated || estimation.estimatedInputTokens, outputAccumulated || 1);
          telemetryLogger.reconcileRequest(requestId, 0.0, 'failed', 'cancelled');
          telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'cancelled' } });
          streamReconciled = true;
          console.log(`[Reconcile] Request ${requestId} cancelled mid-stream. Reservation reclaimed.`);
        }
      }
    });

    return reply.send(stream);
  } catch (error: any) {
    console.error('Error forwarding request:', error);
    if (!streamReconciled) {
       telemetryLogger.emitEvent({ eventType: 'request_stream_failed', sessionId, requestId, metadata: { error: error.message } });
       telemetryLogger.reconcileRequest(requestId, 0, 'failed', 'failed');
       telemetryLogger.emitEvent({ eventType: 'request_reconciled', sessionId, requestId, metadata: { state: 'failed' } });
    }
    return reply.status(500).send({ error: { message: error.message } });
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
        type: errorType === 'runaway_loop_detected' ? 'invalid_request_error' : 'permission_error',
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
