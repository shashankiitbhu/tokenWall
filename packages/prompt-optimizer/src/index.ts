import { countTokens } from '@tokenwall/estimators';

export interface OptimizationResult {
  originalText: string;
  optimizedText: string;
  tokensSaved: number;
  savingsPercent: number;
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

function minifyJsonBlocks(text: string): string {
  let result = text.replace(/```json\s*([\s\S]*?)\s*```/ig, (match, jsonString) => {
    try {
      return `\`\`\`json\n${JSON.stringify(JSON.parse(jsonString))}\n\`\`\``;
    } catch {
      return match;
    }
  });

  let out = '';
  let i = 0;
  while (i < result.length) {
    let c = result[i];
    if ((c === '{' || c === '[') && (i === 0 || /\s/.test(result[i-1]))) {
      let braceCount = 0;
      let inString = false;
      let escape = false;
      let j = i;
      for (; j < result.length; j++) {
        let char = result[j];
        if (inString) {
          if (escape) escape = false;
          else if (char === '\\') escape = true;
          else if (char === '"') inString = false;
        } else {
          if (char === '"') inString = true;
          else if (char === '{' || char === '[') braceCount++;
          else if (char === '}' || char === ']') {
            braceCount--;
            if (braceCount === 0) {
              let block = result.substring(i, j + 1);
              try {
                let parsed = JSON.parse(block);
                if (block.length > 50) {
                  let minified = JSON.stringify(parsed);
                  out += minified;
                  i = j + 1;
                  break;
                }
              } catch (e) {}
              break;
            }
          }
        }
      }
      if (braceCount === 0 && i !== j + 1) {
        out += result[i]; i++;
      } else if (braceCount !== 0) {
        out += result[i]; i++;
      }
    } else {
      out += result[i]; i++;
    }
  }
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
    // Only deduplicate blocks larger than a certain threshold to avoid stripping common short phrases
    if (trimmed.length > 50) {
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) {
        // Replace with a marker instead of silently dropping, so LLM knows something was here
        output.push(`[Duplicate content removed]`);
        continue;
      }
      seen.add(normalized);
    }
    output.push(block);
  }
  
  return output.join('\n\n');
}

export class PromptOptimizer {
  optimize(prompt: string, model: string): OptimizationResult {
    const originalTokens = countTokens(prompt, model);
    
    // First apply JSON minification
    let optimized = minifyJsonBlocks(prompt);

    // Apply Context Deduplication
    optimized = deduplicateContext(optimized);

    // Apply filler regexes
    for (const item of CONVERSATIONAL_FILLERS) {
      optimized = optimized.replace(item.pattern, item.replacement);
    }

    // Clean up double spaces left over from replacements without destroying newlines
    optimized = optimized.replace(/ {2,}/g, ' ');
    // Collapse 3+ newlines into double newlines to save tokens without losing paragraph structure
    optimized = optimized.replace(/\n{3,}/g, '\n\n').trim();

    const optimizedTokens = countTokens(optimized, model);
    const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
    const savingsPercent = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 100) : 0;

    return {
      originalText: prompt,
      optimizedText: optimized,
      tokensSaved,
      savingsPercent
    };
  }
}

export * from './tools';
