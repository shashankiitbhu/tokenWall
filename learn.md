# TokenWall Architectural & Conceptual Guide

This guide details the system architecture, core concepts, and algorithmic mechanics of TokenWall. It connects software engineering concepts directly to their implementations in the codebase.

---

## 1. System Architecture: Data Plane vs. Control Plane

TokenWall splits its responsibilities into two distinct layers to prevent performance bottlenecks and resolve input/output conflicts.

```
+--------------------------------------------------------------+
|                     DEVELOPER TERMINAL                       |
|                                                              |
|  +-----------------------+        +-----------------------+  |
|  |   Coding Agent        |        |   Interactive CLI     |  |
|  |   (e.g., Claude Code) |        |   (tokenwall approve) |  |
|  +-----------+-----------+        +-----------+-----------+  |
|              |                                ^              |
|              | HTTP Traffic (Port 1984)       | WebSockets   |
|              v                                v              |
|  +-----------+--------------------------------+-----------+  |
|  |                 TOKENWALL DAEMON PROXY                 |  |
|  |                                                        |  |
|  |  +--------------------------------------------------+  |  |
|  |  |  Data Plane (Fastify HTTP Proxy Server)          |  |  |
|  |  +------------------------+-------------------------+  |  |
|  |                           |                            |  |
|  |                           v                            |  |
|  |  +------------------------+-------------------------+  |  |
|  |  |  Control Plane (WebSocket & OS Dialog Coordinator)| |  |
|  |  +------------------------+-------------------------+  |  |
|  |                           |                            |  |
|  |                           v                            |  |
|  |  +------------------------+-------------------------+  |  |
|  |  |  SQLite Database (Budgets, Events, Cache)        |  |  |
|  |  +--------------------------------------------------+  |  |
|  +---------------------------+----------------------------+  |
|                              |                               |
+------------------------------|-------------------------------+
                               v Forward Request
                    +--------------------+
                    | Upstream Provider  |
                    | (Anthropic/OpenAI) |
                    +--------------------+
```

1. **The Data Plane**: A high-performance local HTTP server that acts as a reverse proxy. It intercepts outgoing LLM payloads, runs cost estimations, optimizes prompts, processes incoming Server-Sent Events (SSE) streams, and records telemetry.
2. **The Control Plane**: Manages interactive communications. Because coding agents take over the terminal (`stdin`/`stdout`), any prompt for user approval inside the agent's terminal window will cause input collisions. The control plane routes approval requests out-of-band to a separate terminal window (via WebSocket) or natively to the OS/editor interface.

---

## 2. Network-Level Interception & Stream Parsing

### Concept: Reverse Proxying & Base URL Redirection
A reverse proxy acts as an intermediary for client requests, directing them to one or more upstream servers. TokenWall intercepts traffic without needing custom root certificates (which can cause security/CA issues) by leveraging standard environment variables supported by LLM client SDKs:
* `ANTHROPIC_BASE_URL`
* `OPENAI_BASE_URL`
* `GEMINI_BASE_URL`

When `tokenwall exec` runs or the VS Code extension activates, these environment variables are set to `http://127.0.0.1:1984`. Any SDK request target is redirected to the local Fastify proxy server.

### Code Implementation
* **Host Binding**: To enforce a local-only loopback security constraint, the gateway binds exclusively to the loopback interface (`127.0.0.1`) rather than `0.0.0.0` in [apps/gateway/src/index.ts:L1291](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/index.ts#L1291).
* **Interception Routes**: The routes `/v1/chat/completions`, `/v1/messages`, and `/v1/models/*` are registered in [apps/gateway/src/index.ts](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/index.ts).

### Concept: Non-Blocking Stream Parsing
LLMs use Server-Sent Events (SSE) to stream back completions chunk-by-chunk. To monitor token usage and capture tool calls, TokenWall cannot wait for the entire response to buffer, as this would add noticeable latency for the user. Instead, it parses incoming bytes incrementally:
1. It listens to the upstream data stream chunk-by-chunk.
2. It feeds these chunks into a streaming parser (e.g., using `eventsource-parser` in [apps/gateway/src/index.ts](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/index.ts)).
3. It detects structural content like Anthropic's `input_json` delta blocks for tool executions.
4. It increments the local counter and passes the data immediately down to the client.

---

## 3. SQLite Transactional Budget Reservations

### Concept: Double-Spend/Concurrent Request Prevention
If multiple parallel client scripts call the proxy simultaneously, they might all query the database, find that the budget is valid, and launch requests. By the time they finish, the collective cost exceeds the budget. 

To solve this, TokenWall implements a **reservation system** that temporarily freezes the estimated cost of in-flight requests.

```
       Client Request
             |
             v
+──────────────────────────+
|  SQLite Transaction Start |
|                          |
|  1. Read Spend History   |
|  2. Read Active Reserves |
|  3. Add Estimated Cost   |
|                          |
|       Is Budget > Sum?   |
|         /        \       |
|       YES         NO     |
|       /            \     |
|  Create Reserve    Block |
+──────────────────────────+
             |
             v
     Forward Upstream
```

### Code Implementation
* **Locking the budget**: In [packages/core/src/db.ts](file:///Users/shashankkumar/Documents/tokenWall/packages/core/src/db.ts#L336), `reserveBudget` runs within a synchronous SQLite transaction (`this.db.transaction`).
* **Evaluation Formula**:
  $$\text{Total Projected Spend} = \text{Committed Spend} + \text{Active Reservations} + \text{New Estimated Cost}$$
  If this exceeds the configuration limit, the transaction fails, the reservation is rejected, and the proxy returns a `402 Payment Required` block.
* **Reconciliation**: Upon completion of the stream, `reconcileBudget` deletes the temporary reservation record and updates the persistent `current_spend` with the actual cost reported by the model.
* **Daemon Recovery**: If the proxy server crashes, stale reservations are left behind. On boot, `reconcileStaleReservations` is called to delete all active reservations and mark their corresponding requests as failed.

---

## 4. Algorithmic Runaway Loop Detection

Autonomous agents can enter infinite loops when debugging errors. TokenWall monitors request metadata to detect loops using three heuristics in [packages/budget-engine/src/loopDetector.ts](file:///Users/shashankkumar/Documents/tokenWall/packages/budget-engine/src/loopDetector.ts):

### 1. Context Window Velocity
* **The Concept**: When an agent gets stuck in a loop appending outputs to its memory, the context size grows exponentially.
* **The Heuristic**: The detector checks the input token count of the last 4 requests. If the input tokens grow by $>40\%$ consecutively on every request, it flags a context velocity overrun and blocks the next request.

### 2. Sequential Failures
* **The Concept**: If code modifications keep failing compilation, the agent might repeatedly retry the same action.
* **The Heuristic**: If 3 consecutive requests failed (returned HTTP errors from the provider or system) and a new request is sent within 15 seconds with a similar input token size (within 3 tokens), the proxy halts execution.

### 3. Prompt Footprint Similarity
* **The Concept**: Due to security and privacy limits, TokenWall does not log raw prompt text to the database. Thus, it cannot use string similarity algorithms (like Levenshtein distance).
* **The Heuristic**: It treats the input token size as a structural fingerprint. If 4 consecutive requests have the exact same input token count within a rapid interval ($<15$ seconds), it indicates the agent is sending the exact same payload repeatedly.

---

## 5. Detailed Optimization Mechanics & Token Economics

TokenWall uses five distinct optimization strategies to reduce token consumption at the gateway level.

```
       +---------------------------------------------+
       |             Raw Request Payload             |
       +----------------------o----------------------+
                              |
            [Split System / User / Tool Parts]
                              |
         +--------------------+--------------------+
         |                                         |
         v (JSON / Files)                          v (Text / Prompts)
+--------+--------+                       +--------+--------+
|  JsonCrusher    |                       | PromptOptimizer |
|  (AST Truncate, |                       | (Boilerplate,   |
|  Entropy Check) |                       | Multi-Newline)  |
+--------+--------+                       +--------+--------+
         |                                         |
         v (Source Code)                           v (Tool Definitions)
+--------+--------+                       +--------+--------+
| CodeCompressor  |                       | ToolRouter &    |
| (Strip Comments,|                       | SchemaOptimizer |
| Blank Lines)    |                       | (Trim & Clean)  |
+--------+--------+                       +--------+--------+
         |                                         |
         +--------------------+--------------------+
                              |
                              v
         +--------------------+--------------------+
         |   ToolPayloadCrusher (Crush Arrays)     |
         +--------------------+--------------------+
                              |
                              v
                   Optimized Output Payload
```

### A. Abstract Syntax Tree (AST) JSON Crushing
JSON structures generated by automated agent tools (such as database results or package configurations) are highly redundant. Standard minification only removes whitespace. TokenWall implements a structured AST crushing algorithm:
* **AST Walking**: In [JsonCrusher.crush](file:///Users/shashankkumar/Documents/tokenWall/packages/context-engine/src/index.ts#L40), TokenWall parses the JSON string into an AST tree in memory and recursively traverses the nodes.
* **Bounded Truncation**: When walking arrays, if the length exceeds 3 elements, it truncates the array to the first 3 items and injects a metadata string: `"... [TokenWall: N more items truncated]"`. Similarly, string properties longer than 200 characters are truncated.
* **Entropy-Aware Preservation**: Standard string truncation breaks core logic if it mutates identifiers. Before truncating a string, `JsonCrusher` runs a regex scan to check for high-entropy signatures (e.g., UUIDs or JWTs):
  ```typescript
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(obj);
  ```
  If it matches, the string is left untouched, preserving relational integrity across files and database references.

### B. Syntactic Code Comment & Whitespace Stripping
Code listings sent to context windows do not require human-readable comments. In [CodeCompressor.compress](file:///Users/shashankkumar/Documents/tokenWall/packages/context-engine/src/index.ts#L78), TokenWall runs regex filters to clean up files before transmission:
* **Block Comments**: Stripped using the non-greedy pattern: `code.replace(/\/\*[\s\S]*?\*\//g, '')`.
* **Single-Line Comments**: Stripped using a negative lookbehind assertion to avoid stripping protocol schemes like `http://` or `file://`:
  ```typescript
  code.replace(/(?<!:)\/\/.*$/gm, '')
  ```
* **Python/Bash Comments**: Stripped using a negative lookbehind assertion to avoid stripping string variables containing `#`:
  ```typescript
  code.replace(/(?<!["'`])#.*$/gm, '')
  ```
* **Whitespace Compression**: Collapses multi-newline blocks into a single newline to optimize formatting overhead.

### C. Conversational Boilerplate Filtering
Coding agents generate conversational fluff (e.g., "kindly help me with...", "could you please go ahead and...").
* **Dictionary Replacements**: In [PromptOptimizer.optimize](file:///Users/shashankkumar/Documents/tokenWall/packages/prompt-optimizer/src/index.ts#L112), TokenWall applies a static lookup dictionary that replaces verbose filler terms with direct instructions (e.g., replacing `"i want you to analyze the codebase and tell me"` with `"analyze"`).
* **Fenced Codeblock Minification**: Minimizes inline JSON code blocks within markdown fences (` ```json ... ``` `) by parsing and stringifying them on a single line.

### D. Tool Schema Optimization & Routing
Passing a massive array of tools to an LLM increases the cost of the input context on *every single request turn*.
* **Lightweight Tool Routing**: In [ToolRouter.route](file:///Users/shashankkumar/Documents/tokenWall/packages/prompt-optimizer/src/tools.ts#L4), if the number of registered tools exceeds 15, TokenWall performs keyword matching. It extracts keywords from the prompt and filters out tools whose names or parameters do not match, while retaining common system tools (like `bash` or `read`).
* **Tautological Description Clean-up**: In [ToolSchemaOptimizer.optimize](file:///Users/shashankkumar/Documents/tokenWall/packages/prompt-optimizer/src/tools.ts#L35), parameter descriptions that are redundant (e.g., parameter `port`, description `"The port"`) are deleted to save tokens.
* **Aggressive Truncation**: Truncates long tool descriptions to their first sentence. If constraint keywords (like `must`, `never`, `always`, `required`) are detected, the truncation is bypassed to protect agent guidelines.

### E. Tool Output / Payload Crushing
* **Homogeneity Verification**: In [ToolPayloadCrusher.optimizeToolResult](file:///Users/shashankkumar/Documents/tokenWall/packages/prompt-optimizer/src/tools.ts#L109), TokenWall intercepts tool responses. It checks if the output is a uniform array. If it is heterogeneous (containing objects with different structures), compression is aborted to avoid breaking the calling agent.
* **Head-and-Tail Truncation**: If uniform, it truncates the array, keeping the first and last few items and inserting a placeholder.
* **Token-Bounded Fallback**: If the payload is still too large, it performs incremental token-bounded truncation to ensure the result fits within a 1,500 token limit.

---

## 6. Reversible Context Compression (CCR)

### Concept: Dynamic Tool Injection & Fallback Retrieval
To prevent models from reading bloated static files (like lockfiles or verbose node_modules listings) repeatedly, TokenWall compresses the prompt. However, to keep the model from failing if it genuinely needs that data, it implements **Reversible Context Compression**:

```
[Client Request]
- Read package-lock.json
- Run analyze

     | (Intercepted by Gateway)
     v
1. Extract package-lock.json contents
2. Cache contents in SQLite (id: ccr_lk_99)
3. Rewrite prompt: "Read [TokenWall Reversible Content: ccr_lk_99]"
4. Inject tool schema: "tokenwall_retrieve_content"
5. Send to Upstream LLM

     | (Model decides it must read the lockfile)
     v
[Model Tool Call]: tokenwall_retrieve_content(content_id: 'ccr_lk_99')
     |
     v (Intercepted locally by Gateway)
Gateway queries SQLite -> returns original lockfile contents
     |
     v (Returned directly to model)
[Model receives data without client agent knowing]
```

### Code Implementation
* **Analyzer & Compression**: [packages/context-engine/src/index.ts](file:///Users/shashankkumar/Documents/tokenWall/packages/context-engine/src/index.ts) processes text payloads.
* **Tool Resolution**: The gateway catches calls to `tokenwall_retrieve_content` in [apps/gateway/src/index.ts](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/index.ts), queries the database's `cached_contents` table, and returns the result immediately.

---

## 7. Prompt Cache Alignment

### Concept: KV Cache Stability
LLM provider-side prompt caching (like Anthropic's Prompt Caching) works by reusing the compiled Key-Value (KV) states of previous tokens. Caching is highly sequential: if a prompt is 10,000 tokens long, and a single character changes at token 500, the remaining 9,500 tokens must be re-evaluated, invalidating the cache. 

Dynamic tokens (like dynamic session IDs, environment timestamps, or random seeds) inserted early in system prompts invalidate KV caching.

### Code Implementation
* **Volatile Token Scanning**: [CacheAligner.detectVolatileTokens](file:///Users/shashankkumar/Documents/tokenWall/packages/context-engine/src/index.ts#L111) scans prompt headers for dynamic constructs:
  * UUIDs
  * ISO8601 timestamps
  * JWT tokens
  * Hex hashes
* **Breakpoint Injections**: In [apps/gateway/src/index.ts](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/index.ts), if the client does not already specify cache control blocks (to avoid exceeding Anthropic's limit of 4 cache control blocks), TokenWall automatically injects `"cache_control": { "type": "ephemeral" }` on system prompts, tools lists, and historical turns to prompt the provider to save those blocks.

---

## 8. Decoupled Inter-Process Communication (IPC)

### Concept: Non-Blocking WS Signals & Coalescing
Since the proxy is run-time blocking, it must hold the HTTP connection open while waiting for the developer to approve or reject a request. It does this by creating a deferred promise and sending WebSocket events.

### Code Implementation
* **WebSocket Dispatch**: The [ControlPlane](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/control-plane.ts) class manages active connections to `/ws/control`. 
* **Promise Coalescing**: When an agent starts up, it often fans out parallel requests (e.g. asking for files and directory structure at the same time). If TokenWall prompted the user for each request, they would see multiple duplicate popups.
  In [control-plane.ts:L67](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway/src/control-plane.ts#L67), the `requestApproval` method stores in-flight approvals in a map keyed by `${sessionId}:${model}`. If a request with the same key is active, it returns the *same* pending promise.
* **Keep-Alive Heartbeats**: To prevent OS-level TCP idle timeouts from severing connection pipes during long user deliberations, the VS Code extension runs a 15-second ping/pong heartbeat.
* **Scripted Fallback**: If no WebSocket clients are listening, the gateway executes a native child process command (such as AppleScript on macOS) to prompt the user directly on their screen, bypassing the terminal.

---

## 9. Smart Model Routing & Task Complexity Classification

### Concept: Task-Complexity Mapping
High-tier models (like Claude 3.5 Opus) are expensive, while low-tier models (like Claude 3.5 Haiku) are fast and cheap. Many tasks during an agent's run (such as running lints, formatting files, or checking directory listings) do not require high-tier reasoning.

### Code Implementation
* **Complexity Classifier**: In [ModelRouter](file:///Users/shashankkumar/Documents/tokenWall/packages/routing-engine/src/index.ts#L55), the model router evaluates:
  1. The prompt size.
  2. The presence of tool definitions.
  3. Keyword mappings (e.g., matching low-complexity terms like `typo`, `prettier`, `eslint` vs high-complexity terms like `architect`, `refactor`, `memory leak`).
* **Alternative Generation**: It generates alternative options with projected cost savings. The user can select these options to redirect requests to cheaper endpoints (e.g., routing OpenAI requests to `gpt-4o-mini` instead of `gpt-4o`).
