import { countTokens } from '@tokenwall/estimators';
import { CodeCompressor, CachedContent } from './code-compressor';
import { ToolPruner } from './tool-pruner';

export interface OptimizationResult {
  originalText: string;
  optimizedText: string;
  tokensSaved: number;
  savingsPercent: number;
}

export interface PromptOptimizerOptions {
  disableCodeCompression?: boolean;
}

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
function minifyJsonBlocks(text: string): { text: string, cachedContents: CachedContent[] } {
  const cachedContents: CachedContent[] = [];
  const minified = text.replace(/```json\s*([\s\S]*?)\s*```/ig, (match, jsonString) => {
    try {
      const parsed = JSON.parse(jsonString);
      const walk = (obj: any): any => {
        if (Array.isArray(obj)) {
          // Array compression
          if (obj.length > 50) {
            const id = `ccr_js_${Math.random().toString(36).substring(2, 9)}`;
            cachedContents.push({ id, content: JSON.stringify(obj.slice(3)) });
            return [
              walk(obj[0]),
              walk(obj[1]),
              walk(obj[2]),
              `... [TokenWall Reversible Content: ${id} - ${obj.length - 3} more items truncated. Use tokenwall_retrieve_content tool with content_id='${id}']`
            ];
          }
          return obj.map(walk);
        } else if (obj && typeof obj === 'object') {
          const newObj: any = {};
          for (const key of Object.keys(obj)) {
            newObj[key] = walk(obj[key]);
          }
          return newObj;
        } else if (typeof obj === 'string') {
          if (obj.length > 200) {
            // Check for high-entropy/structured ID shapes to bypass truncation
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj);
            const isJWT = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(obj);
            const isHex = /^[0-9a-fA-F]{32,}$/.test(obj);
            const isBase64 = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(obj) && !obj.includes(' ');
            
            if (isUUID || isJWT || isHex || isBase64) {
              return obj; // Bypass truncation for IDs and tokens
            }
            const id = `ccr_js_${Math.random().toString(36).substring(2, 9)}`;
            cachedContents.push({ id, content: obj });
            return obj.substring(0, 100) + `... [TokenWall Reversible Content: ${id} - string truncated, original length ${obj.length}. Use tokenwall_retrieve_content tool with content_id='${id}'] ...` + obj.substring(obj.length - 100);
          }
        }
        return obj;
      };
      // JSON.stringify inherently removes all redundant whitespace
      return `\`\`\`json\n${JSON.stringify(walk(parsed), null, 2)}\n\`\`\``;
    } catch {
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
function deduplicateContext(text: string): string {
  const blocks = text.split('\n\n');
  const seen = new Set<string>();
  const output: string[] = [];

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

export interface OptimizationResult {
  originalText: string;
  optimizedText: string;
  tokensSaved: number;
  savingsPercent: number;
  cachedContents?: CachedContent[];
}

export class PromptOptimizer {
  optimize(prompt: string, model: string, options?: PromptOptimizerOptions): OptimizationResult {
    const originalTokens = countTokens(prompt, model);
    
    let allCachedContents: CachedContent[] = [];

    // First apply JSON minification
    const jsonResult = minifyJsonBlocks(prompt);
    let optimized = jsonResult.text;
    allCachedContents.push(...jsonResult.cachedContents);
    
    // Apply AST-based Skeletonization and Sparsification
    const codeResult = CodeCompressor.compress(optimized, options?.disableCodeCompression);
    optimized = codeResult.optimizedText;
    allCachedContents.push(...codeResult.cachedContents);

    // Apply Context Deduplication
    optimized = deduplicateContext(optimized);

    // Apply filler regexes
    for (const item of CONVERSATIONAL_FILLERS) {
      optimized = optimized.replace(item.pattern, item.replacement);
    }

    // Clean up double spaces left over from replacements without destroying newlines
    // WARNING: Do NOT use `/ {2,}/g` to strip spaces, as it destroys code/XML indentation and causes LLM token bloat!
    // Collapse 3+ newlines into double newlines to save tokens without losing paragraph structure
    optimized = optimized.replace(/\n{3,}/g, '\n\n').trim();

    const optimizedTokens = countTokens(optimized, model);
    const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
    const savingsPercent = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;

    return {
      originalText: prompt,
      optimizedText: optimized,
      tokensSaved,
      savingsPercent,
      cachedContents: allCachedContents
    };
  }
}

export * from './tools';
export { ToolPruner };
