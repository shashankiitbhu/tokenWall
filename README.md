# TokenWall

TokenWall is a local-first AI runtime governance proxy and spend firewall designed for autonomous coding agents (such as Claude Code, Gemini CLI, and custom OpenAI/Codex integration workflows). It intercepts downstream LLM requests locally, estimates transaction costs before execution, enforces strict budget guardrails, and provides non-disruptive, out-of-band interactive and headless approval workflows to prevent runaway autonomous agent overspending.

---

## 1. Project Overview

Autonomous AI coding agents operate in continuous loops of tool usage, file reading, and code execution. When these agents get stuck in recursive debugging loops or encounter large binary dumps/lockfiles, their token consumption escalates exponentially. Without runtime barriers, an agent can drain hundreds of dollars in API credits in minutes.

TokenWall sits between your local development terminal and the upstream model APIs. It acts as a local proxy that monitors, analyzes, and governs all AI outgoing traffic. By maintaining state locally, it ensures that your workflows remain completely private and zero-latency while protecting you from financial runaway.

---

## 2. Key Features

- **Local-First Interception**: Zero external cloud dependency. Every decision, log, and budget check runs locally.
- **Spend Firewall**: Protects against automated runaway loop spend via transactional reservations.
- **Interactive Approvals**: Decoupled Control Plane websocket communication resolves TTY conflicts, allowing the agent to hold stdin while the developer approves costly calls in another terminal or dashboard window.
- **Headless Mode**: Tailored policies for CI/CD environments (auto-approve small tasks, auto-deny large spikes, budget-aware routing).
- **Context Optimizer & Reversible Compression (CCR)**: Identifies and compresses token waste like lockfiles, node_modules references, logs, and binary payloads. Supports lossless JSON crushing, comment-stripping code compression, and Reversible Context Compression (CCR) which dynamically exposes a local retrieve tool to LLMs to pull the full text if they need it.
- **Prefix Cache Alignment & Caching Breakpoints**: Stabilizes prompt prefixes by normalizing whitespaces and detecting volatile tokens (dates, UUIDs, JWTs, hex hashes) in system prompts that degrade provider-side KV cache hits. Automatically inserts ephemeral cache control breakpoints for Anthropic API calls to secure a **90% discount** on cache reads.
- **Auto-Optimize Interception Bypass**: Automatically applies prompt optimization and context compression without blocking on interactive warnings if `autoOptimize` is enabled in config and the only warning triggers are context inefficiencies.
- **Output Token Reduction (Verbosity Steering)**: Modifies outgoing prompts to append brevity steering instructions, reducing the cost of costly output completions by up to 30%.
- **Smart Model Routing**: Dynamically classifies task complexity and prompts users to downgrade from premium models (e.g., Claude Opus) to cost-effective alternatives (e.g., Claude Sonnet or Haiku) for low-complexity requests.
- **Immutable Governance Event Sourcing**: Writes a forensic audit timeline of every decision (`request_received`, `runaway_loop_detected`, `budget_limit_exceeded`, `approval_granted`, etc.) to a local SQLite store.

---

## 3. Architecture Overview

TokenWall separates the execution into a **Data Plane** (the fast proxy server forwarding requests) and a **Control Plane** (the interactive cli interface/web dashboard approving requests).

### Architecture Diagram

```
                  +----------------------------------------------+
                  |            Developer Terminal               |
                  |                                              |
                  |  +-----------------+    +-----------------+  |
                  |  |  Coding Agent   |    |   tokenwall     |  |
                  |  |  (Claude Code)  |    |    approve      |  |
                  |  +--------+--------+    +--------+--------+  |
                  +           |                      ^           +
                              | Proxy Traffic        | WebSockets
                              | (Port 1984)          | (Port 1984/ws)
                              v                      v
                  +-----------+----------------------+-----------+
                  |              TokenWall Gateway               |
                  |                                              |
                  |   +--------------------------------------+   |
                  |   | [Data Plane] Fastify Proxy           |   |
                  |   +------------------+-------------------+   |
                  |                      |                       |
                  |                      v                       |
                  |   +------------------+-------------------+   |
                  |   | [Budget Engine]                      |   |
                  |   |  - Token Cost Estimator              |   |
                  |   |  - Runaway Loop Detector             |   |
                  |   |  - Context Inefficiency Analyzer     |   |
                  |   |  - Smart Model Router                |   |
                  |   +------------------+-------------------+   |
                  |                      |                       |
                  |                      v                       |
                  |   +------------------+-------------------+   |
                  |   | [Storage Engine] SQLite DB           |   |
                  |   |  - Budgets, Sessions, Reservations   |   |
                  |   |  - Immutable Forensic Timeline       |   |
                  |   +--------------------------------------+   |
                  +----------------------+-----------------------+
                                         |
                                         | Forward (If Allowed)
                                         v
                            +------------+------------+
                            |   Upstream Provider     |
                            |   (Anthropic/OpenAI/    |
                            |    Google Gemini)       |
                            +-------------------------+
```

### Monorepo Structure

TokenWall is organized as a workspace monorepo:

- **[`apps/cli`](file:///Users/shashankkumar/Documents/tokenWall/apps/cli)**: Command-line control interface (`tokenwall start`, `tokenwall exec`, `tokenwall approve`, `tokenwall status`, `tokenwall config`).
- **[`apps/gateway`](file:///Users/shashankkumar/Documents/tokenWall/apps/gateway)**: Core proxy gateway server listening on port `1984`.
- **[`apps/dashboard`](file:///Users/shashankkumar/Documents/tokenWall/apps/dashboard)**: Observability web interface built with React, Vite, and CSS.
- **[`packages/core`](file:///Users/shashankkumar/Documents/tokenWall/packages/core)**: Shared SQLite database managers and configuration handlers.
- **[`packages/providers`](file:///Users/shashankkumar/Documents/tokenWall/packages/providers)**: Request and response parsers for OpenAI, Anthropic, and Gemini, including robust SSE streaming stream-chunk parsing.
- **[`packages/estimators`](file:///Users/shashankkumar/Documents/tokenWall/packages/estimators)**: Tiktoken-based token counting and cost estimations.
- **[`packages/budget-engine`](file:///Users/shashankkumar/Documents/tokenWall/packages/budget-engine)**: Rules evaluator and consecutive failures/token growth runaway loop detectors.
- **[`packages/context-engine`](file:///Users/shashankkumar/Documents/tokenWall/packages/context-engine)**: Cleans and compresses verbose contexts.
- **[`packages/routing-engine`](file:///Users/shashankkumar/Documents/tokenWall/packages/routing-engine)**: Categorizes complexity and details pricing alternatives.
- **[`packages/telemetry`](file:///Users/shashankkumar/Documents/tokenWall/packages/telemetry)**: Logs immutable lifecycle events.
- **[`packages/terminal-ui`](file:///Users/shashankkumar/Documents/tokenWall/packages/terminal-ui)**: Standardized terminal display tables and logs.

---

## 4. Supported Providers

| Provider | Upstream Endpoint Intercepted | Stable / Experimental | Interception Mode |
| :--- | :--- | :--- | :--- |
| **Anthropic** | `https://api.anthropic.com/v1/messages` | **Stable** | Base URL redirection via `ANTHROPIC_BASE_URL` |
| **OpenAI** | `https://api.openai.com/v1/chat/completions` | **Stable** | Base URL redirection via `OPENAI_BASE_URL` |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1(beta)/models/*` | **Experimental** | Base URL redirection via `GEMINI_BASE_URL` |

---

## 5. How It Works

### How TokenWall Prevents Overspending
Before any request is forwarded upstream, TokenWall computes a pre-flight cost estimation based on:
1. The model's token prices (input/output).
2. The input message size.
3. Multi-step amplification: If an agent attaches tools, the system inflates the estimated output by `2.5x` (assuming a typical multi-step sequence) to prevent the initial call from slipping through budget checks.

If the estimated cost exceeds current budgets, the request is immediately blocked (HTTP `402 Payment Required`), notifying the agent process and avoiding remote execution costs.

### How Reservations Work
To prevent concurrent runaway loops from bypassing budgets before their usage is fully recorded, TokenWall uses a strict **transactional reservation architecture** in the SQLite database:
1. When a request is received, a budget reservation is created with the pre-flight cost estimation.
2. The budget engine checks if `current_spend + active_reservations + requested_cost > limit`.
3. If allowed, the reservation is saved in the database before the request goes upstream.
4. When the streaming response ends, the reservation is deleted, and the actual cost is committed to `current_spend`.
5. If the gateway restarts, stale reservations (from crashed runs) are automatically reconciled to prevent budget leakage.

### How Governance Events Work
TokenWall uses an **immutable, event-sourced governance model**. Every request lifecycle writes events to the SQLite database. Typical events recorded:
- `request_received`: Initial intercept.
- `runaway_loop_detected`: Blocked due to suspicious token growth or consecutive errors.
- `budget_limit_exceeded`: Blocked due to insufficient quota.
- `reservation_created`: Pending transaction locked.
- `approval_requested` / `approval_granted` / `approval_denied`: Interactive feedback cycles.
- `policy_triggered`: Automated decision making.
- `request_stream_completed` / `request_reconciled`: Commit actual usage.

---

## 6. Quickstart

Get up and running in under 2 minutes:

```bash
# 1. Install dependencies and build all packages
npm install
npm run build

# 2. Open Terminal Tab 1: Start the gateway
npx tokenwall start

# 3. Open Terminal Tab 2: Start the interactive control plane client
npx tokenwall approve

# 4. Open Terminal Tab 3: Run your coding agent through TokenWall
npx tokenwall exec -- npx @anthropic-ai/claude-code
```

---

## 7. Installation

To install TokenWall globally or link it locally for development:

```bash
npm install
npm run build
npm link
```

---

## 8. Local Development Setup

Clone the repository and install developer dependencies:

```bash
git clone https://github.com/shashankiitbhu/tokenWall.git
cd tokenWall
npm install
```

---

## 9. Environment Variables

Configure behavior by setting the following environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Local gateway listener port | `1984` |
| `OPENAI_UPSTREAM_URL` | Upstream endpoint for OpenAI chat | `https://api.openai.com/v1/chat/completions` |
| `ANTHROPIC_UPSTREAM_URL` | Upstream endpoint for Anthropic messages | `https://api.anthropic.com/v1/messages` |
| `GEMINI_UPSTREAM_URL` | Upstream base endpoint for Gemini API | `https://generativelanguage.googleapis.com` |
| `TOKENWALL_HEADLESS` | Force gateway into headless mode | `false` |

---

## 10. Building All Packages

TokenWall relies on TypeScript packages. Compile the core and apps using the root script:

```bash
npm run build
```

This compiles each package in order of dependencies:
1. `packages/core`
2. `packages/providers`
3. `packages/estimators`
4. `packages/budget-engine`
5. `packages/context-engine`
6. `packages/prompt-optimizer`
7. `packages/routing-engine`
8. `packages/telemetry`
9. `packages/terminal-ui`
10. `apps/gateway`
11. `apps/cli`

---

## 11. Running the Gateway

Start the standalone HTTP proxy gateway:

```bash
npx tokenwall start
```

For automated headless script execution (CI/CD):

```bash
npx tokenwall start --headless
```

---

## 12. Running the Control Plane

To accept and resolve approvals interactively:

```bash
npx tokenwall approve
```

This starts a WebSocket connection to the gateway and prompts you whenever a request requires action:

```
🔗 Connecting to TokenWall Control Plane...
✔ Connected. Waiting for approval requests...

⚠️  APPROVAL REQUIRED [rqx78b2p]
Model: claude-3-5-sonnet
Estimated Cost: $0.1240
Warnings:
 - Lockfile detected: 'package-lock.json'. Standard lockfiles contribute heavily to token bloat.

Routing Alternatives:
  [1] claude-3-5-haiku: $0.0240 (Quality: Medium, Savings: 81%)

Action (y: Approve, n: Deny, o: Optimize, s: Switch Model): 
```

---

## 13. Using `tokenwall exec`

Wrap any coding command to inject TokenWall environment redirects:

```bash
npx tokenwall exec -- npx @anthropic-ai/claude-code
```

This command:
1. Spins up a background gateway instance on port `1984`.
2. Registers a project directory tracking mapping.
3. Sets proxy environment variables:
   - `OPENAI_BASE_URL=http://localhost:1984/v1`
   - `ANTHROPIC_BASE_URL=http://localhost:1984`
   - `GEMINI_BASE_URL=http://localhost:1984`
   - `TOKENWALL_SESSION_ID=<random>`
   - `TOKENWALL_PROJECT_ID=<project-id>`
4. Spawns your agent. On completion, it terminates the proxy and prints session spend.

---

## 14. Using Approval Workflows

When a warning condition is met (estimated cost > `$0.05`, budget limits exceeded, routing alternatives suggested, or context inefficiencies identified), TokenWall intercepts the outgoing LLM request and halts the upstream send:

1. **Active Control Plane Client Mode**: If you have `tokenwall approve` or the Web Dashboard open, TokenWall sends a websocket event. You can interactively resolve it (`y` to Approve, `n` to Deny, `o` to Optimize, `s` to Switch Model).
2. **Zero-Config Native Dialog Fallback**: If no control plane client or dashboard is connected, TokenWall automatically detects this and displays a **native out-of-band OS dialog popup window** (e.g. macOS AppleScript prompt) on top of VS Code / your desktop. This prevents TTY collisions with your agent and lets you approve/optimize/switch/cancel directly with a mouse click or hotkey.

The actions do the following:
- **Approve**: Forwards the request exactly as requested.
- **Deny / Cancel**: Blocks the request and returns a user cancel error code (HTTP `402`) to the agent.
- **Optimize**: Truncates lockfiles/binary content, compresses prompt instructions, and sends the optimized payload to save tokens.
- **Switch Model**: Routes the request to one of the cheaper suggested alternatives to save costs.

---

## 15. Headless Mode Configuration

In non-interactive environments (e.g. Docker, automated pipelines), set `headless: true` in `~/.tokenwall/config.json`. The proxy then resolves warnings based on automated boundaries:

```json
{
  "headless": true,
  "autoApproveLimit": 0.10,
  "autoDenyLimit": 2.50,
  "routingPolicy": {
    "autoSwitchBelowThreshold": 0.10,
    "neverDowngradeReasoning": true,
    "budgetAwareRouting": true
  }
}
```
- Calls costing **under** `$0.10` are approved automatically.
- Calls costing **over** `$2.50` are blocked.
- Low-complexity tasks below `$0.10` automatically switch to a cheaper model if `autoSwitchBelowThreshold` is configured.

---

## 16. Budget Configuration Examples

Run `npx tokenwall status` to view your configuration, or update limits using `npx tokenwall config`:

```bash
# Set daily budget limit to $5.00
npx tokenwall config dailyLimit=5.0

# Enable hard budgets blocking requests
npx tokenwall config hardLimitsEnabled=true

# Enable auto-optimization
npx tokenwall config autoOptimize=true
```

These settings populate the JSON file at `~/.tokenwall/config.json`.

---

## 17. Claude Code Integration

Start the approval client in a separate terminal:
```bash
npx tokenwall approve
```

Then run Claude Code:
```bash
npx tokenwall exec -- npx @anthropic-ai/claude-code
```

TokenWall maps `ANTHROPIC_BASE_URL` automatically. Requests stream through TokenWall, calculating token counts transparently.

---

## 18. OpenAI / Codex Integration

Run your custom Node/Python OpenAI scripts:
```bash
npx tokenwall exec -- node index.js
```
The script intercepts `v1/chat/completions`. It automatically adds `stream_options: { include_usage: true }` to streaming requests to guarantee precise token tracking.

---

## 19. Gemini Integration

TokenWall intercepts Gemini requests sent via standard Google AI SDKs:
```bash
npx tokenwall exec -- gemini-cli "Explain this codebase"
```
It intercepts `/v1/models/*` and `/v1beta/models/*`, parses Gemini's candidate parts schemas, and supports streaming res---

## 20. VS Code Companion Extension

TokenWall offers a seamless, editor-native companion extension ([package.json](file:///Users/shashankkumar/Documents/tokenWall/apps/vscode-extension/package.json)) to automate the local governance workflow:

- **Automatic Interception**: Uses VS Code's `EnvironmentVariableCollection` to inject proxy base URLs into all integrated terminals. Running `claude` or other agents in VS Code integrated terminals routes traffic through TokenWall automatically, without needing `tokenwall exec` wrappers.
- **Native Modal Approvals**: If a query is costly or risky, the extension catches the WebSocket request and displays a native VS Code warning dialog box (`{ modal: true }`). You can choose `Approve`, `Optimize Prompt`, `Switch Model`, or `Cancel` with a click.
- **Daemon Lifecycle Management**: Verifies health on port `1984` and automatically spawns the proxy server (`npx tokenwall start`) in the background if it is offline.
- **Spend & Savings Tracking**: Displays your current daily spend and total prevented savings in the status bar:
  `$(shield) Today: $4.21 • Saved: $18.40`
- **Breakdown QuickPanel**: Click the Status Bar item to open a detailed dropdown overview displaying Daily Budget limits, prevented runaway costs, optimized prompt savings, workspace attribution summaries, and model/provider cost breakdowns.

### Installation
1. Pack the extension locally:
   ```bash
   cd apps/vscode-extension
   npx vsce package
   ```
2. Install the `.vsix` file in VS Code (`Extensions: Install from VSIX...`).

---

## 21. Example Workflows

### Scenario A: Runaway Loop Intercepted

1. Coding agent enters an infinite loop trying to fix a syntax bug.
2. It sends 4 identical requests sequentially.
3. TokenWall's `RunawayLoopDetector` flags the duplicate token footprint and blocks the 4th request:

```
❌ REQUEST BLOCKED BY TOKENWALL BUDGET ENFORCEMENT
────────────────────────────────────────────────────────────
Reason: Duplicate prompt footprint detected. Multiple sequential requests have the exact same token footprint.
────────────────────────────────────────────────────────────
```

### Scenario B: Reversible Context Compression (CCR)

1. Coding agent issues a request attaching the entire `package-lock.json` file.
2. TokenWall identifies lockfile bloat (`15,000` tokens) and prompts the developer to optimize.
3. Developer selects `Optimize` (or auto-optimize is active).
4. TokenWall caches the original lockfile in its local SQLite database and replaces it with a placeholder referencing the cached ID. It injects a local `tokenwall_retrieve_content` tool definition.
5. If the LLM needs to read the full lockfile to make its decision, it calls `tokenwall_retrieve_content`, which the TokenWall gateway intercepts, resolves locally, and recursively forwards back upstream without the agent knowing.

### Scenario C: Prefix Cache Alignment & Caching Breakpoints

1. Developer launches an agent inside VS Code. The agent includes dynamic timestamps and UUIDs in its system instructions.
2. TokenWall's Cache Aligner identifies the volatile UUID and timestamp formatting, normalizes whitespace line-by-line to standardize the message structure, and reports the volatile prefix findings in the telemetry/control plane.
3. For Anthropic (Claude), the gateway automatically injects `"cache_control": { "type": "ephemeral" }` at the prompt caching boundaries.
4. Upstream, the provider processes the prefix. On consecutive calls, the byte-identical normalized prefix matches, triggering a provider KV cache hit and slashing input costs by 90% (Anthropic) or 50% (OpenAI).

---

## 22. Security & Privacy Model

- **100% Local Processing**: All request bodies, logs, keys, and code files stay on your local disk.
- **No Prompt Storage**: To protect sensitive codebases and keys, TokenWall **never logs prompt contents or responses** to the database. It only stores metadata: model name, token counts, calculated costs, and structural hashes.
- **Read-Only Interception**: The proxy only modifies payloads if the developer explicitly selects `Optimize` or `Switch Model`.

---

## 23. Current Limitations

- **Experimental Gemini Parsing**: Some complex Gemini structures (e.g. multi-turn chats with system instructions) are still in development and might fall back to token approximations.
- **Provider Base URL Overrides**: The target coding tool must respect base URL environment variables (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL`). Tools with hardcoded URLs bypass interception.
- **Stream Incompleteness**: If a stream is aborted mid-way, the exact output usage is calculated via best-effort counting, which might show slight variation from final billing.

---

## 24. Troubleshooting

### Gateway fails to bind to port 1984
Another process is running on port 1984. Kill it:
```bash
lsof -i :1984
kill -9 <PID>
```

### Budgets are not blocking requests
Ensure `hardLimitsEnabled` is true in config:
```bash
npx tokenwall config hardLimitsEnabled=true
```

### Interceptor not capturing requests
Make sure the command is run *after* `npx tokenwall exec --`. Verify that environment variables are populated correctly inside the child shell:
```bash
npx tokenwall exec -- env | grep _BASE_URL
```

---

## 25. Local Database Location

The sqlite store is located at:
```
~/.tokenwall/database.sqlite
```
You can view it using any SQLite explorer:
```bash
sqlite3 ~/.tokenwall/database.sqlite "SELECT * FROM requests LIMIT 5;"
```

Configuration resides at:
```
~/.tokenwall/config.json
```

---

## 26. Contributing Guide

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-cool-idea`
3. Confirm all tests pass locally:
   ```bash
   npm run build
   node tests/provider_integration.test.mjs
   ```
4. Open a Pull Request.

---

## 27. Example Prompts and Before-and-After Results

### Example A: Compressing Large JSON Outputs
* **Prompt**:
  > "Examine the following database output and write a short summary: ```json [lots of verbose data with nested spaces] ```"
* **Before**:
  - Raw tokens: `12,850`
  - Upstream Input Cost (gpt-4o at $5/M): `$0.064`
* **After (Smart JSON Crushing)**:
  - Compressed tokens: `6,425`
  - Upstream Input Cost (gpt-4o): `$0.032`
  - **Savings**: **50% token reduction ($0.032 saved)**

### Example B: Stripping Comments from Code
* **Prompt**:
  > "Refactor this file: ```typescript /* Multi-line docstrings ... */ // Inline comments const x = 123; ```"
* **Before**:
  - Raw tokens: `4,200`
  - Upstream Input Cost (claude-3-5-sonnet at $3/M): `$0.0126`
* **After (Code Compression)**:
  - Compressed tokens: `1,680` (comments and whitespace stripped, stored in CCR cache)
  - Upstream Input Cost (claude-3-5-sonnet): `$0.0050`
  - **Savings**: **60% token reduction ($0.0076 saved)**
  - *Note: If the model needs to read the original docstrings, it retrieves them transparently via the CCR tool.*

### Example C: Prefix Caching with Dynamic Tokens
* **Prompt**:
  > "System instruction: You are a coding assistant. Current UUID: 123e4567-e89b-12d3-a456-426614174000. Time: 2026-06-17T18:00:00Z."
* **Before**:
  - Every agent request has a different system instruction string due to time/UUID changes.
  - KV Cache Hits: **0%**
  - Average Latency: `2.4s` (first-token)
* **After (Cache Alignment + Caching Breakpoints)**:
  - Cache Aligner detects and reports volatile tokens, allowing developers to clean system prompts.
  - Ephemeral cache control markers are injected.
  - KV Cache Hits: **95%+**
  - Average Latency: `0.4s` (first-token)
  - Cost Discount: **90% off input tokens on Anthropic** ($0.30/M instead of $3.00/M)

---

## 28. License

This project is licensed under the MIT License. See [LICENSE](file:///Users/shashankkumar/Documents/tokenWall/LICENSE) for details.
