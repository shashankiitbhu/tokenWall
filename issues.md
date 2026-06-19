# TokenWall & Claude Code Integration: Post-Mortem

This document serves as a permanent reference for the complex edge cases encountered when integrating TokenWall with the Claude Code CLI, and how they were resolved. 

Claude Code is an advanced autonomous agent that behaves very differently from simple chat clients. Its use of prompt caching, parallel tool execution, and aggressive retry logic exposed four fundamental bugs in TokenWall's proxy and control plane.

## 1. The Hanging Dialog (WebSocket Disconnects)
**Symptom:** 
When the TokenWall approval dialog popped up in VS Code, taking longer than 30 seconds to click "Approve" caused Claude Code to hang indefinitely ("spinning in results"). Clicking "Approve" in the UI did nothing.
**Root Cause:**
OS-level TCP idle timeouts silently dropped the WebSocket connection between the VS Code extension and the TokenWall background daemon while the user was interacting with the dialog.
**Fix:**
Implemented a robust 15-second `wsClient.ping()` Keep-Alive heartbeat in `apps/vscode-extension/src/extension.ts` to keep the control plane connection alive indefinitely during long approval deliberations.

## 2. Duplicate Dialogs on Fanned-Out Requests (Promise Coalescing Failure)
**Symptom:**
Executing a single prompt in Claude Code caused 3 to 4 identical TokenWall approval dialogs to spawn simultaneously in VS Code.
**Root Cause:**
Claude Code fans out multiple asynchronous requests in parallel at the start of a session (e.g., listing directories, reading context). Because these payloads vary slightly in size, their estimated token costs were different (e.g., `$0.0485` vs `$0.0192`). TokenWall's `requestApproval` Promise coalescing logic used the exact `estimatedCost` as part of the `cacheKey`. The differing costs generated unique cache keys, bypassing the coalescing map.
**Fix:**
Stripped the cost metric from the `cacheKey` entirely in `apps/gateway/src/control-plane.ts`, reducing it strictly to `${sessionId}:${model}`. This allows parallel fanned-out requests (and minor token fluctuations during retries) to perfectly merge into a single UI dialog. The total financial spend is still safely enforced by the `budgetEvaluator`, which runs before the coalescing step.

## 3. Infinite Retry Loops (HTTP Status Code Masking)
**Symptom:**
TokenWall blocked requests with a `400 Loop Protection: Three consecutive requests failed` error, even when the user approved the prompt.
**Root Cause:**
Claude Code sent a request for an invalid model name (`claude-opus-4-8`), prompting Anthropic to return a `400 Bad Request`. However, TokenWall's streaming proxy (`proxyStreamWithCCR`) caught this upstream error and blindly masked it as a `500 Internal Server Error` to the client. The Anthropic SDK in Claude Code interpreted the 500 as a temporary server outage and endlessly retried the request, quickly triggering TokenWall's runaway Loop Detector.
**Fix:**
Modified `proxyStreamWithCCR` and the gateway proxy in `apps/gateway/src/index.ts` to extract the native upstream `statusCode` and pass it unaltered to the client. Receiving the native `400` error correctly halts the SDK's retry logic, preventing the Loop Detector from firing on client-fatal errors.

## 4. Anthropic Cache Control Max Block Limit Exceeded
**Symptom:**
Upstream error: `400 invalid_request_error: max of 4 blocks with cache control maybe provided found 5`.
**Root Cause:**
To save users money, TokenWall's "Auto Optimize" feature actively modifies outgoing payloads to inject up to 3 `cache_control` blocks (for system prompts, tools, and message history). Claude Code *already natively utilizes Prompt Caching*, injecting up to 4 blocks itself. When TokenWall forcibly injected its optimizations, the combined total (7) exceeded Anthropic's hard limit of 4.
**Fix:**
Updated `injectAnthropicCacheControl` in `apps/gateway/src/index.ts` with a lightweight scan (`JSON.stringify(body).includes('"cache_control"')`). If TokenWall detects that the client natively supports and uses prompt caching, it gracefully skips its own injections, guaranteeing the 4-block limit is never breached.
