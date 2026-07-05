"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolTrimmer = exports.ToolPruner = exports.PromptOptimizer = exports.ASTDiffApplier = exports.ASTDiffer = exports.CodeChunker = void 0;
const crypto_1 = __importDefault(require("crypto"));
const estimators_1 = require("@tokenwall/estimators");
const code_compressor_1 = require("./code-compressor");
const tool_pruner_1 = require("./tool-pruner");
Object.defineProperty(exports, "ToolPruner", { enumerable: true, get: function () { return tool_pruner_1.ToolPruner; } });
var code_chunker_1 = require("./code-chunker");
Object.defineProperty(exports, "CodeChunker", { enumerable: true, get: function () { return code_chunker_1.CodeChunker; } });
var ast_differ_1 = require("./ast-differ");
Object.defineProperty(exports, "ASTDiffer", { enumerable: true, get: function () { return ast_differ_1.ASTDiffer; } });
Object.defineProperty(exports, "ASTDiffApplier", { enumerable: true, get: function () { return ast_differ_1.ASTDiffApplier; } });
const CONVERSATIONAL_FILLERS = [
    // Semantic compression (stripping irrelevant boilerplate and summarizing agent/skills systems)
    { pattern: /<system-reminder>[\s\S]*?<\/system-reminder>/gi, replacement: '' },
    {
        pattern: /Available agent types for the Agent tool:[\s\S]*?(?:so they run concurrently\.|\- statusline\-setup: [^\n]*)/gi,
        replacement: `Available agents (launch concurrently where possible):
- claude (Default, Tools: *)
- claude-code-guide (Q&A: Claude Code, CLI, SDK, API. Tools: Bash, Read, WebFetch, WebSearch. Check existing/completed first!)
- Explore (Read-only sweeping search. Reads excerpts, no audits. Tools: All except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- general-purpose (Multi-step tasks/complex research. Tools: *)
- Plan (Design implementation plans/architect. Tools: All except Agent, ExitPlanMode, Edit, Write, NotebookEdit)
- statusline-setup (Configure statusline. Tools: Read, Edit)`
    },
    {
        pattern: /The following skills are available for use with the Skill tool:[\s\S]*?(?:\- security\-review: [^\n]*|\- review: [^\n]*|\- run: [^\n]*)/gi,
        replacement: `Available skills:
- deep-research (Fact-checked report. Ask clarifying Qs if vague.)
- update-config (Modify settings.json for hooks, permissions, env vars.)
- keybindings-help (Customize keys in ~/.claude/keybindings.json.)
- verify (Verify fixes/PRs by running app & manual check.)
- code-review (Review diff for bugs/cleanup. --comment or --fix.)
- simplify (Refactor code for quality/reusability. No bug hunting.)
- fewer-permission-prompts (Add common Bash/MCP tools to settings.json allowlist.)
- loop (Run command/prompt on interval, e.g. /loop 5m /foo. Omit interval to self-pace.)
- claude-api (API/SDK ref. TRIGGER: read BEFORE opening file if Claude/Anthropic/LLM/MCP is named. SKIP: if OpenAI/Gemini/GPT/Llama/Mistral/Ollama is named or in grep 'openai|google.generativeai|genai|mistralai|cohere|ollama')
- run (Launch/test app. Use project skill or defaults.)
- init (Init CLAUDE.md with docs.)
- review (Review PR.)
- security-review (PR/branch security review.)`
    },
    // Conversational fillers
    { pattern: /could you please go ahead and/gi, replacement: '' },
    { pattern: /please take a look at/gi, replacement: 'check' },
    { pattern: /can you write a highly detailed, clean, and production-grade/gi, replacement: 'write' },
    { pattern: /write a very clean and thoroughly documented function that/gi, replacement: 'write function to' },
    { pattern: /i want you to analyze the codebase and tell me/gi, replacement: 'analyze' },
    { pattern: /please make sure to write tests and handle error cases/gi, replacement: 'include tests and error handling' },
    { pattern: /please edit this file and change/gi, replacement: 'edit file to' },
    { pattern: /here is the content of the file/gi, replacement: 'file content' },
    { pattern: /please explain how this works/gi, replacement: 'explain' },
    { pattern: /thank you so much/gi, replacement: '' },
    { pattern: /kindly help me with/gi, replacement: 'resolve' }
];
function minifyJsonBlocks(text, metrics, disableJsonMasking) {
    const cachedContents = [];
    if (metrics) {
        const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/ig;
        const matches = [...text.matchAll(jsonBlockRegex)];
        metrics.json.regexTotalDetected += matches.length;
    }
    const minified = text.replace(/```json\s*([\s\S]*?)\s*```/ig, (match, jsonString) => {
        try {
            const parsed = JSON.parse(jsonString);
            const walk = (obj) => {
                if (Array.isArray(obj)) {
                    // Array compression
                    if (obj.length > 50 && !disableJsonMasking) {
                        const contentString = JSON.stringify(obj.slice(3));
                        const hash = crypto_1.default.createHash('sha256').update(contentString).digest('hex').substring(0, 32);
                        const id = `ccr_js_${hash}`;
                        cachedContents.push({ id, content: contentString });
                        return [
                            walk(obj[0]),
                            walk(obj[1]),
                            walk(obj[2]),
                            `... [TokenWall Reversible Content: ${id} - ${obj.length - 3} more items truncated. Use tokenwall_retrieve_content tool with content_id='${id}']`
                        ];
                    }
                    return obj.map(walk);
                }
                else if (obj && typeof obj === 'object') {
                    const newObj = {};
                    for (const key of Object.keys(obj)) {
                        newObj[key] = walk(obj[key]);
                    }
                    return newObj;
                }
                else if (typeof obj === 'string') {
                    if (obj.length > 200 && !disableJsonMasking) {
                        // Check for high-entropy/structured ID shapes to bypass truncation
                        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj);
                        const isJWT = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(obj);
                        const isHex = /^[0-9a-fA-F]{32,}$/.test(obj);
                        const isBase64 = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(obj) && !obj.includes(' ');
                        if (isUUID || isJWT || isHex || isBase64) {
                            return obj; // Bypass truncation for IDs and tokens
                        }
                        const hash = crypto_1.default.createHash('sha256').update(obj).digest('hex').substring(0, 32);
                        const id = `ccr_js_${hash}`;
                        cachedContents.push({ id, content: obj });
                        return obj.substring(0, 100) + `... [TokenWall Reversible Content: ${id} - string truncated, original length ${obj.length}. Use tokenwall_retrieve_content tool with content_id='${id}'] ...` + obj.substring(obj.length - 100);
                    }
                }
                return obj;
            };
            // JSON.stringify inherently removes all redundant whitespace
            if (metrics)
                metrics.json.successfullyOptimized++;
            return `\`\`\`json\n${JSON.stringify(walk(parsed), null, 2)}\n\`\`\``;
        }
        catch (e) {
            if (metrics) {
                metrics.json.fallbackParseFailure++;
                metrics.sampledFailures.push({ type: 'parse_failure', reason: e.message || 'JSON Parse Error', snippet: match.substring(0, 200) });
            }
            return match;
        }
    });
    return { text: minified, cachedContents };
}
/**
 * Context Deduplication:
 * Based on concepts from open-source context engineering tools (like Headroom and SemHash),
 * this function prunes redundant information (e.g., repeating logs or identical paragraphs).
 * It splits the text into blocks separated by double newlines (`\n\n`), tracks seen blocks using a `Set`,
 * and replaces large exact duplicate blocks with a placeholder to save waste tokens.
 */
function deduplicateContext(text) {
    const blocks = text.split('\n\n');
    const seen = new Set();
    const output = [];
    for (const block of blocks) {
        const trimmed = block.trim();
        // Only deduplicate blocks larger than a certain threshold
        if (trimmed.length > 50) {
            // Normalization: strip timestamps, UUIDs, hex hashes, and all numbers
            const normalized = trimmed.toLowerCase()
                .replace(/\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, '') // ISO timestamps
                .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '') // UUIDs
                .replace(/\b[0-9a-f]{8,}\b/gi, '') // Hex hashes
                .replace(/\b\d+\b/g, '') // All remaining numbers
                .trim();
            if (seen.has(normalized)) {
                // Replace with a marker instead of silently dropping
                output.push(`[Duplicate content removed]`);
                continue;
            }
            seen.add(normalized);
        }
        output.push(block);
    }
    return output.join('\n\n');
}
let _magikaInstance = null;
async function getMagika() {
    if (!_magikaInstance) {
        try {
            const magikaModule = require('magika/node');
            const Magika = magikaModule.MagikaNode || magikaModule.Magika;
            if (Magika && typeof Magika.create === 'function') {
                _magikaInstance = await Magika.create();
            }
            else if (Magika) {
                const inst = new Magika();
                await inst.load();
                _magikaInstance = inst;
            }
        }
        catch (e) {
            console.warn('[TokenWall] ⚠️ Magika not available. Falling back to heuristic detection.');
        }
    }
    return _magikaInstance;
}
class PromptOptimizer {
    async optimize(prompt, model, options) {
        const originalTokens = (0, estimators_1.countTokens)(prompt, model);
        let allCachedContents = [];
        let compressionMap = [];
        let chunkedBlocks = [];
        const coverage = {
            json: { magikaDetected: 0, regexTotalDetected: 0, successfullyOptimized: 0, fallbackParseFailure: 0 },
            code: { magikaDetected: 0, regexTotalDetected: 0, successfullyOptimized: 0, fallbackParseFailure: 0, fallbackOptOutSystemGuard: 0, fallbackOptOutUserConfig: 0 },
            sampledFailures: []
        };
        // Magika independent baseline
        if (prompt.length > 50) {
            const magika = await getMagika();
            if (magika) {
                try {
                    const bytes = new TextEncoder().encode(prompt.substring(0, 4000));
                    const prediction = await magika.identifyBytes(bytes);
                    const label = prediction?.label || prediction;
                    if (label === 'json' || label === 'jsonl') {
                        coverage.json.magikaDetected = 1;
                    }
                    else if (['python', 'javascript', 'typescript', 'go', 'rust', 'cpp', 'java'].includes(label)) {
                        coverage.code.magikaDetected = 1;
                    }
                }
                catch (e) { }
            }
        }
        // First apply JSON minification
        const jsonResult = minifyJsonBlocks(prompt, coverage, options?.disableJsonMasking);
        let optimized = jsonResult.text;
        allCachedContents.push(...jsonResult.cachedContents);
        // Apply AST-based Skeletonization and Sparsification
        const codeResult = code_compressor_1.CodeCompressor.compress(optimized, options?.disableCodeCompression, options?.optOutReason || null, coverage);
        optimized = codeResult.optimizedText;
        allCachedContents.push(...codeResult.cachedContents);
        if (codeResult.compressionMap) {
            compressionMap.push(...codeResult.compressionMap);
        }
        if (codeResult.chunkedBlocks) {
            chunkedBlocks.push(...codeResult.chunkedBlocks);
        }
        if (coverage.code.magikaDetected > 0 && coverage.code.regexTotalDetected === 0) {
            coverage.sampledFailures.push({ type: 'magika_mismatch', reason: 'Magika detected code, but regex found no fence', snippet: prompt.substring(0, 200) });
        }
        if (coverage.json.magikaDetected > 0 && coverage.json.regexTotalDetected === 0) {
            coverage.sampledFailures.push({ type: 'magika_mismatch', reason: 'Magika detected JSON, but regex found no fence', snippet: prompt.substring(0, 200) });
        }
        // Apply Context Deduplication
        optimized = deduplicateContext(optimized);
        // Apply filler regexes
        for (const item of CONVERSATIONAL_FILLERS) {
            optimized = optimized.replace(item.pattern, item.replacement);
        }
        if (options?.isHistorical) {
            // Strip volatile sub-sections from historical environment details
            optimized = optimized.replace(/# Visual Studio Code Visible Files\n[\s\S]*?(?=\n# |\n<\/environment_details>)/g, '');
            optimized = optimized.replace(/# Visual Studio Code Open Tabs\n[\s\S]*?(?=\n# |\n<\/environment_details>)/g, '');
            optimized = optimized.replace(/# Current Time\n[\s\S]*?(?=\n# |\n<\/environment_details>)/g, '');
            optimized = optimized.replace(/# Context Window Usage\n[\s\S]*?(?=\n# |\n<\/environment_details>)/g, '');
            optimized = optimized.replace(/# Current Mode\n[\s\S]*?(?=\n# |\n<\/environment_details>)/g, '');
            // Strip task_progress boilerplate
            optimized = optimized.replace(/# task_progress List \(Optional - Plan Mode\)[\s\S]*?ensures nothing is missed\./gi, '');
        }
        // Clean up double spaces left over from replacements without destroying newlines
        // WARNING: Do NOT use `/ {2,}/g` to strip spaces, as it destroys code/XML indentation and causes LLM token bloat!
        // Collapse 3+ newlines into double newlines to save tokens without losing paragraph structure
        optimized = optimized.replace(/\n{3,}/g, '\n\n').trim();
        const optimizedTokens = (0, estimators_1.countTokens)(optimized, model);
        const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
        const savingsPercent = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;
        return {
            originalText: prompt,
            optimizedText: optimized,
            tokensSaved,
            savingsPercent,
            cachedContents: allCachedContents,
            coverage,
            compressionMap,
            chunkedBlocks
        };
    }
}
exports.PromptOptimizer = PromptOptimizer;
__exportStar(require("./tools"), exports);
var tool_trimmer_1 = require("./tool-trimmer");
Object.defineProperty(exports, "ToolTrimmer", { enumerable: true, get: function () { return tool_trimmer_1.ToolTrimmer; } });
__exportStar(require("./verbosity-steering"), exports);
