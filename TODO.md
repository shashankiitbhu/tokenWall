# TokenWall Implementation Tasks — v2

## 0. Trust & Safety Floor (blocks everything else — do first)
- `[x]` **Fail-open passthrough**
  - *Impact: Critical | Difficulty: Low*
  - `[x]` Add `TOKENWALL_KILL_SWITCH` check in `apps/gateway/src/index.ts`.
  - `[x]` Wrap `ContextAnalyzer.analyze` in try/catch.
  - `[x]` Wrap `BudgetEvaluator.evaluate` in try/catch.
  - `[x]` Wrap `ModelRouter.generateRoutingOptions` in try/catch.
  - `[x]` Wrap `PromptOptimizer.optimize` and `ToolRouter` in try/catch.
- `[x]` **Write-path safety for `CodeCompressor`**
  - *Impact: Critical | Difficulty: Medium*
  - `[x]` Interim fix: detect turns where an edit-capable tool is active and serve those files **uncompressed**.
  - `[x]` Proper fix (can follow): build a `CompressionMap` (original↔compressed offset ranges) per file; reverse-map outbound edits.
  - `[x]` Fallback: If reverse-mapping fails, fail open (allow tool execution to fail gracefully so the agent falls back to fresh `read_file`).
- `[x]` **Replace regex comment/whitespace stripping with tree-sitter node-span extraction**
  - *Impact: High | Difficulty: Medium*
  - `[x]` Install `web-tree-sitter` in `@tokenwall/prompt-optimizer`. (Changed to native tree-sitter bindings)
  - `[x]` Add `tree-sitter-javascript.wasm` and `tree-sitter-typescript.wasm`. (Changed to native tree-sitter bindings)
  - `[x]` Refactor `packages/prompt-optimizer/src/code-compressor.ts` to use `web-tree-sitter` for AST parsing.
  - `[x]` Implement slice-based comment excision algorithm based on `comment` node byte ranges.
- `[x]` **Fix shadow-state hash/diff ordering**
  - *Impact: High | Difficulty: Low*
  - `[x]` Confirmed `fileShadowState` diffs **original** file content, not post-`CodeCompressor` output (it runs in `ContextAnalyzer` prior to optimization).
- `[x]` **Quality harness: expand fixtures for the above**
  - *Impact: Critical | Difficulty: Low*
  - (Completed during the interim fix implementation).

## 1. High Priority (Must Have for MVP)
- `[x]` **Regression harness (quality evaluation)**
- `[x]` **`cache_control` breakpoint injection**
- `[x]` **Diff-based context updates**
- `[x]` **Metrics/observability surface**
- `[ ]` **Multi-extension adapters (Cline + Roo minimum, Continue stretch)**
- `[ ]` **Privacy/data-handling statement + local-only mode**

## 2. Medium Priority
- `[x]` **Lost-in-the-middle mitigation**
- `[x]` **Template diffing** (Structural AST Diffing / GumTree for write-path mapping)
- `[x]` **Hierarchical summarization** (addressed via Observation Masking/Demand Paging)
- `[x]` **AST-aware chunking (full function/class-boundary chunking)**

## 3. Lower Priority
- `[ ]` **Relevance-scored context packing (MMR / cross-encoder)**
- `[ ]` **Semantic cache**
- `[ ]` **Batch tool-result folding**
- `[ ]` **Constrained/grammar decoding for tool calls**
- `[ ]` **Speculative tool-call prediction**
