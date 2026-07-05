import { NormalizedRequest } from '@tokenwall/providers';
import { TokenWallConfig } from '@tokenwall/core';
import { countTokens } from '@tokenwall/estimators';
import * as swc from '@swc/core';
import { CacheAlignerPipeline } from './cache-aligner';
import * as crypto from 'crypto';
import * as Diff from 'diff';

export * from './cache-aligner';
export * from './importance';
export * from './query-analyzer';

import { QueryAnalyzer } from './query-analyzer';
import { ImportanceEngine } from './importance';
import { LostInMiddleMitigator } from './lost-in-middle';

export interface InefficiencyItem {
  type: 'lockfile' | 'node_modules' | 'binary' | 'minified' | 'logs' | 'duplicate' | 'json' | 'code' | 'volatile_prefix';
  description: string;
  target: string;
  approximateTokens: number;
  potentialSavingsPercent: number; // e.g. 95 for lockfiles, 50 for logs
}

export interface ContextReport {
  inefficiencies: InefficiencyItem[];
  totalWasteTokens: number;
  cleanMessages: NormalizedRequest['messages'];
  cachedContents: { id: string; content: string }[];
  autoOptimized?: boolean;
  deduplicationsApplied?: number;
}

let _magikaInstance: any = null;
async function getMagika() {
  if (!_magikaInstance) {
    try {
      const magikaModule = require('magika/node');
      const Magika = magikaModule.MagikaNode || magikaModule.Magika;
      if (Magika && typeof Magika.create === 'function') {
        _magikaInstance = await Magika.create();
      } else if (Magika) {
        const inst = new Magika();
        if (typeof inst.load === 'function') await inst.load();
        _magikaInstance = inst;
      }
    } catch (e) {
      console.warn('[TokenWall] ⚠️ Magika not available. Falling back to heuristic detection.');
    }
  }
  return _magikaInstance;
}

export class JsonCrusher {
  static crush(jsonStr: string): string {
    try {
      const parsed = JSON.parse(jsonStr);
      const walk = (obj: any): any => {
        if (Array.isArray(obj)) {
          if (obj.length > 3) {
            return [
              walk(obj[0]),
              walk(obj[1]),
              walk(obj[2]),
              `... [TokenWall: ${obj.length - 3} more items truncated]`
            ];
          }
          return obj.map(walk);
        } else if (obj && typeof obj === 'object') {
          const newObj: any = {};
          for (const key of Object.keys(obj)) {
            newObj[key] = walk(obj[key]);
          }
          return newObj;
        } else if (typeof obj === 'string' && obj.length > 200) {
          // Entropy Preservation: Preserve high-entropy strings like UUIDs/Tokens
          const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(obj);
          if (!isUuid) {
             return obj.substring(0, 100) + '... [TokenWall: Truncated value]';
          }
        }
        return obj;
      };
      return JSON.stringify(walk(parsed));
    } catch {
      // Best effort whitespace compression if invalid JSON
      return jsonStr.replace(/\s+/g, '').trim();
    }
  }
}

export class CodeCompressor {
  static compress(code: string, lang?: string, queryKeywords?: string[]): string {
    // Query-Aware Check: If the code contains one of the user's high-priority keywords,
    // we perform a "light" compression (preserving comments) to retain context.
    if (queryKeywords && queryKeywords.length > 0) {
      const lowerCode = code.toLowerCase();
      const hasMatch = queryKeywords.some(kw => lowerCode.includes(kw));
      if (hasMatch) {
        // Light compression: just trim excessive whitespace/newlines, keep comments
        return code.replace(/\n{3,}/g, '\n\n').trim();
      }
    }

    if (lang) {
      const lower = lang.toLowerCase();
      if (['javascript', 'typescript', 'js', 'ts'].includes(lower)) {
        try {
          const isTs = lower.includes('ts');
          const ast = swc.parseSync(code, {
            syntax: isTs ? 'typescript' : 'ecmascript',
            comments: false,
            target: 'esnext'
          });
          const result = swc.printSync(ast, {
            minify: true,
            isModule: true,
            sourceMaps: false
          });
          return result.code.trim();
        } catch (e) {
          // Fall back to regex if SWC fails to parse (e.g. invalid syntax snippet)
        }
      }
    }

    // Strip block comments (/* ... */)
    let compressed = code.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Strip single-line comments (// ...) but avoid stripping URL schemes
    compressed = compressed.replace(/(?<!:)\/\/.*$/gm, '');
    
    // Strip Python/Bash comments (# ...) but avoid stripping string boundaries
    compressed = compressed.replace(/(?<!["'`])#.*$/gm, '');

    // Strip excessive newlines and spaces
    compressed = compressed.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    return compressed;
  }
}

// Replaced by ./cache-aligner.ts

export class ContextAnalyzer {
  async analyze(req: NormalizedRequest, config?: TokenWallConfig): Promise<ContextReport> {
    const inefficiencies: InefficiencyItem[] = [];
    let totalWasteTokens = 0;
    const cleanMessages = JSON.parse(JSON.stringify(req.messages)) as NormalizedRequest['messages'];
    const cachedContents: { id: string; content: string }[] = [];
    const fileShadowState = new Map<string, { content: string; hops: number }>();
    const MAX_DIFF_HOPS = 3;
    let deduplicationsApplied = 0;
    
    // Stage 5: Query-Aware Extraction
    const queryKeywords = QueryAnalyzer.extractFromMessages(cleanMessages);

    // Tool-Aware Compression Bypass
    // If edit-capable tools are present, we must preserve exact whitespace, comments, 
    // and line numbers to prevent silent write-path corruption or tool exact-match failures.
    
    const effectiveConfig = (config ? { ...config } : {}) as any;

    const isReversible = effectiveConfig.reversibleCompression !== false;

    for (let i = 0; i < cleanMessages.length; i++) {
      const msg = cleanMessages[i];
      let content = msg.content;

      // 0. Cache alignment detection & normalization
      if ((msg.role === 'system' || i === 0) && effectiveConfig.cacheAlignment !== false) {
        const pipeline = new CacheAlignerPipeline();
        const alignResult = pipeline.align(content, msg.role, msg.role === 'system', effectiveConfig);
        
        if (alignResult.prompt !== content) {
          content = alignResult.prompt;
        }
        
        if (alignResult.findings.length > 0) {
          for (const finding of alignResult.findings) {
            if (finding.type !== 'fingerprint') {
              inefficiencies.push({
                type: 'volatile_prefix',
                description: `Volatile content format (${finding.type}) detected in system prompt: '${finding.value.substring(0, 10)}...'. Cacheability Score: ${alignResult.cacheabilityScore}/100.`,
                target: finding.value,
                approximateTokens: countTokens(finding.value, req.model),
                potentialSavingsPercent: 50
              });
            }
          }
        }
      }

      // 0.5 Intra-Payload File Deduplication and Diffing
      // Detect Markdown-style fencing
      const mdFileBlockRegex = /(?:File|Path|Filename):\s*([/\\]?[^\s"']+)\n(?:```[a-zA-Z0-9_-]*\n)?([\s\S]*?)(?:\n```|$)/gi;
      // Detect XML-style fencing (Cline)
      const xmlFileBlockRegex = /<file_content path="([^"]+)">\n?([\s\S]*?)\n?<\/file_content>/gi;

      const processFileBlock = (fullMatch: string, filePath: string, fileContent: string, regex: RegExp, format: 'md' | 'xml') => {
        const state = fileShadowState.get(filePath);
        let replacement = '';
        
        if (state && state.content === fileContent) {
          replacement = format === 'xml' 
            ? `<file_content path="${filePath}">\n[TokenWall: File identical to earlier occurrence. Refer to the chat history above for ${filePath}]\n</file_content>`
            : `File: ${filePath}\n[TokenWall: File identical to earlier occurrence. Refer to the chat history above for ${filePath}]`;
          
          const beforeTokens = countTokens(fullMatch, req.model);
          const afterTokens = countTokens(replacement, req.model);
          const saved = Math.max(0, beforeTokens - afterTokens);
          
          if (saved > 0) {
            inefficiencies.push({
              type: 'duplicate',
              description: `Intra-payload duplication detected for file: ${filePath}`,
              target: filePath,
              approximateTokens: saved,
              potentialSavingsPercent: 100
            });
            totalWasteTokens += saved;
            deduplicationsApplied++;
            content = content.replace(fullMatch, replacement);
            regex.lastIndex -= (fullMatch.length - replacement.length);
          }
        } else if (state && state.hops < MAX_DIFF_HOPS) {
          try {
            // Generate unified diff
            const patch = Diff.createPatch(filePath, state.content, fileContent, '', '', { context: 1 });
            replacement = format === 'xml'
              ? `<file_content path="${filePath}">\n[TokenWall: File updated. Unified Diff from previous occurrence in chat history:]\n\`\`\`diff\n${patch}\`\`\`\n</file_content>`
              : `File: ${filePath}\n[TokenWall: File updated. Unified Diff from previous occurrence in chat history:]\n\`\`\`diff\n${patch}\`\`\``;
            
            const beforeTokens = countTokens(fullMatch, req.model);
            const diffTokens = countTokens(replacement, req.model);
            
            if (diffTokens < beforeTokens) {
              const saved = beforeTokens - diffTokens;
              inefficiencies.push({
                type: 'duplicate',
                description: `File update diff-compressed for: ${filePath} (${state.hops + 1} hops)`,
                target: filePath,
                approximateTokens: saved,
                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
              });
              totalWasteTokens += saved;
              content = content.replace(fullMatch, replacement);
              regex.lastIndex -= (fullMatch.length - replacement.length);
              fileShadowState.set(filePath, { content: fileContent, hops: state.hops + 1 });
            } else {
              // Diff is larger than full file, fall back to full file
              fileShadowState.set(filePath, { content: fileContent, hops: 0 });
            }
          } catch (e) {
            // Fallback on diff failure
            fileShadowState.set(filePath, { content: fileContent, hops: 0 });
          }
        } else {
          // New file or exceeded hop limit (reanchor)
          fileShadowState.set(filePath, { content: fileContent, hops: 0 });
        }
      };

      let match;
      while ((match = mdFileBlockRegex.exec(content)) !== null) {
        processFileBlock(match[0], match[1], match[2], mdFileBlockRegex, 'md');
      }
      while ((match = xmlFileBlockRegex.exec(content)) !== null) {
        processFileBlock(match[0], match[1], match[2], xmlFileBlockRegex, 'xml');
      }

      // 0.6 Lost-in-the-Middle Mitigation (U-shaped Reordering)
      if (effectiveConfig.lostInMiddleMitigation !== false) {
        content = LostInMiddleMitigator.reorder(content, {
          currentTurnText: i === cleanMessages.length - 1 ? msg.content : cleanMessages[cleanMessages.length - 1].content,
          fileShadowState,
          model: req.model
        });
      }

      // 1. Lockfiles detection
      const lockfileMatch = content.match(/(?:File|path|Filename|attachment):\s*([a-zA-Z0-9_\-\.\/]*lock\.[a-z]+|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)/gi);
      const lockfileRegex = /(\`\`\`[a-z]*\s*[\s\S]*?"dependencies"[\s\S]*?\`\`\`)/g;
      if (lockfileMatch && lockfileRegex.test(content)) {
        lockfileRegex.lastIndex = 0;
        const beforeTokens = countTokens(content, req.model);
        
        if (isReversible) {
          const id = `ccr_lk_${Math.random().toString(36).substring(2, 7)}`;
          cachedContents.push({ id, content });
          content = content.replace(
            lockfileRegex,
            `[TokenWall Reversible Content: ${id} - Truncated Lockfile content. Use tokenwall_retrieve_content tool with content_id='${id}' if you need to read the original content.]`
          );
        } else {
          content = content.replace(
            lockfileRegex,
            '[TokenWall: Truncated Lockfile content. Use package.json for dependencies list]'
          );
        }
        
        const afterTokens = countTokens(content, req.model);
        const saved = Math.max(0, beforeTokens - afterTokens);
        
        if (saved > 0) {
          inefficiencies.push({
            type: 'lockfile',
            description: `Lockfile detected: '${lockfileMatch[0]}'. Standard lockfiles contribute heavily to token bloat.`,
            target: lockfileMatch[0],
            approximateTokens: saved,
            potentialSavingsPercent: 95
          });
          totalWasteTokens += saved;
        }
      }

      // 2. node_modules or .git paths
      if (content.includes('node_modules/') || content.includes('.git/')) {
        const approxTokens = countTokens(content, req.model);
        inefficiencies.push({
          type: 'node_modules',
          description: `References to 'node_modules' or '.git' files detected.`,
          target: content.includes('node_modules/') ? 'node_modules/' : '.git/',
          approximateTokens: approxTokens,
          potentialSavingsPercent: 99
        });
        // We don't add to totalWasteTokens because we don't automatically strip it.
      }

      // 3. Repeated stack traces / large logs
      const traceLines = content.match(/at\s+.*:\d+:\d+/g);
      if (traceLines && traceLines.length > 8) {
        const beforeTokens = countTokens(content, req.model);

        if (isReversible) {
          const id = `ccr_lg_${Math.random().toString(36).substring(2, 7)}`;
          cachedContents.push({ id, content });
          content = `[TokenWall Reversible Content: ${id} - Truncated stack trace frames. Use tokenwall_retrieve_content tool with content_id='${id}' if you need to read the full logs.]\n` + content.substring(0, 500) + '\n... [Remaining frames truncated]';
        } else {
          // Keep only top 3 trace frames, replace rest with message
          const lines = content.split('\n');
          let keptLines = 0;
          const filteredLines = lines.filter((line) => {
            if (line.trim().startsWith('at ')) {
              keptLines++;
              return keptLines <= 3;
            }
            return true;
          });
          if (keptLines > 3) {
            filteredLines.push('... [TokenWall: Truncated remaining stack trace frames]');
          }
          content = filteredLines.join('\n');
        }
        
        const afterTokens = countTokens(content, req.model);
        const saved = Math.max(0, beforeTokens - afterTokens);

        if (saved > 0) {
          inefficiencies.push({
            type: 'logs',
            description: `Oversized stack trace containing ${traceLines.length} repeat references detected.`,
            target: 'stack_trace_repeats',
            approximateTokens: saved,
            potentialSavingsPercent: 60
          });
          totalWasteTokens += saved;
        }
      }

      // 3.5 Unstructured Log Pruning via Importance Scoring
      if (effectiveConfig.importance?.policy && effectiveConfig.importance.policy !== 'conservative' && content.length > 1000) {
        // Only target blocks that look like unstructured logs (lots of lines, not JSON/Code blocks)
        const linesCount = content.split('\n').length;
        if (linesCount > 20 && !content.trim().startsWith('```') && !content.trim().startsWith('{') && !content.trim().startsWith('[')) {
          const importanceEngine = new ImportanceEngine();
          const beforeTokens = countTokens(content, req.model);
          const prunedContent = importanceEngine.pruneLogBlock(content, effectiveConfig.importance.policy);
          
          if (prunedContent.length < content.length) {
            const afterTokens = countTokens(prunedContent, req.model);
            const saved = Math.max(0, beforeTokens - afterTokens);
            if (saved > 10) {
              inefficiencies.push({
                type: 'logs',
                description: `Unstructured log block pruned using '${effectiveConfig.importance.policy}' Importance Policy. Preserved errors/warnings, dropped noise.`,
                target: 'unstructured_log_block',
                approximateTokens: saved,
                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
              });
              totalWasteTokens += saved;
              content = prunedContent;
            }
          }
        }
      }

      // 4. Binary/Base64 payloads
      const base64Regex = /([A-Za-z0-9+/]{100,})/g;
      if (base64Regex.test(content)) {
        base64Regex.lastIndex = 0;
        const beforeTokens = countTokens(content, req.model);
        
        if (isReversible) {
          const id = `ccr_bn_${Math.random().toString(36).substring(2, 7)}`;
          cachedContents.push({ id, content });
          content = content.replace(base64Regex, `[TokenWall Reversible Content: ${id} - Stripped base64 binary block. Use tokenwall_retrieve_content tool with content_id='${id}' if you need the original binary data.]`);
        } else {
          content = content.replace(base64Regex, '[TokenWall: Stripped base64 binary block]');
        }
        
        const afterTokens = countTokens(content, req.model);
        const saved = Math.max(0, beforeTokens - afterTokens);
        
        if (saved > 0) {
          inefficiencies.push({
            type: 'binary',
            description: `Embedded raw binary/base64 block detected.`,
            target: 'base64_data',
            approximateTokens: saved,
            potentialSavingsPercent: 100
          });
          totalWasteTokens += saved;
        }
      }

      // 4.5 Magika Detection for raw unstructured payloads
      if (content.length > 1000 && !content.includes('```')) {
         const magika = await getMagika();
         if (magika) {
           try {
             const bytes = new TextEncoder().encode(content.substring(0, 4000));
             const prediction = await magika.identifyBytes(bytes);
             const label = prediction?.label || prediction;
             
             if (label === 'json' || label === 'jsonl') {
                const crushed = JsonCrusher.crush(content);
                const saved = countTokens(content, req.model) - countTokens(crushed, req.model);
                if (saved > 0) {
                  totalWasteTokens += saved;
                  content = `\`\`\`json\n${crushed}\n\`\`\``;
                  inefficiencies.push({
                    type: 'json',
                    description: `Magika detected raw JSON. Applied Structural Mask and truncation.`,
                    target: 'raw_json',
                    approximateTokens: saved,
                    potentialSavingsPercent: 80
                  });
                }
             } else if (['python', 'javascript', 'typescript', 'go', 'rust', 'cpp', 'java'].includes(label as string)) {
                const compressed = CodeCompressor.compress(content, label as string, queryKeywords);
                const saved = countTokens(content, req.model) - countTokens(compressed, req.model);
                if (saved > 0) {
                  totalWasteTokens += saved;
                  content = `\`\`\`${label}\n${compressed}\n\`\`\``;
                  inefficiencies.push({
                    type: 'code',
                    description: `Magika detected raw ${label} code. Applied Code Compression.`,
                    target: 'raw_code',
                    approximateTokens: saved,
                    potentialSavingsPercent: 50
                  });
                }
             }
           } catch (e) {
             // Silently ignore Magika errors
           }
         }
      }

      // 5. JSON Crushing
      if (effectiveConfig.jsonCrushing !== false) {
        const jsonBlockRegex = /```json\s+([\s\S]*?)\s*```/gi;
        let jsonMatch;
        while ((jsonMatch = jsonBlockRegex.exec(content)) !== null) {
          const rawJson = jsonMatch[1];
          if (rawJson.length > 250) {
            const crushedJson = JsonCrusher.crush(rawJson);
            
            const beforeTokens = countTokens(jsonMatch[0], req.model);
            const newBlock = `\`\`\`json\n${crushedJson}\n\`\`\``;
            const afterTokens = countTokens(newBlock, req.model);
            const saved = Math.max(0, beforeTokens - afterTokens);
            
            if (saved > 10) {
              inefficiencies.push({
                type: 'json',
                description: `Large JSON block minified.`,
                target: 'json_block',
                approximateTokens: saved,
                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
              });
              totalWasteTokens += saved;
              content = content.replace(jsonMatch[0], newBlock);
            }
          }
        }
      }

      // 6. Code Compression
      if (effectiveConfig.codeCompression !== false) {
        const codeBlockRegex = /```(javascript|typescript|js|ts|python|py|rust|rs|go|golang|cpp|c\+\+|java|c|shell|sh|bash)\s+([\s\S]*?)\s*```/gi;
        let codeMatch;
        while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
          const lang = codeMatch[1];
          const rawCode = codeMatch[2];
          if (rawCode.length > 300) {
            const compressedCode = CodeCompressor.compress(rawCode, lang, queryKeywords);
            
            let newBlock = '';
            let id = '';
            if (isReversible) {
              id = `ccr_cd_${Math.random().toString(36).substring(2, 7)}`;
              newBlock = `[TokenWall Reversible Content: ${id} - Code comments stripped to save tokens. Use tokenwall_retrieve_content tool with content_id='${id}' if you need the comments/docstrings.]\n\`\`\`${lang}\n${compressedCode}\n\`\`\``;
            } else {
              newBlock = `\`\`\`${lang}\n${compressedCode}\n\`\`\``;
            }
            
            const beforeTokens = countTokens(codeMatch[0], req.model);
            const afterTokens = countTokens(newBlock, req.model);
            const saved = Math.max(0, beforeTokens - afterTokens);
            
            if (saved > 10) {
              inefficiencies.push({
                type: 'code',
                description: `Code comments and whitespace compressed in ${lang} block.`,
                target: `${lang}_code_block`,
                approximateTokens: saved,
                potentialSavingsPercent: Math.round((saved / beforeTokens) * 100)
              });
              totalWasteTokens += saved;
              if (isReversible) {
                cachedContents.push({ id, content: rawCode });
              }
              content = content.replace(codeMatch[0], newBlock);
            }
          }
        }
      }
      msg.content = content;
    }

    // 8. Apply Rolling Context Window
    const windowResult = ContextWindowManager.fitToBudget(cleanMessages, req.model, undefined, effectiveConfig);
    for (const warning of windowResult.warnings) {
      inefficiencies.push({
        type: 'logs',
        description: warning,
        target: 'ContextWindow',
        approximateTokens: 0,
        potentialSavingsPercent: 100
      });
    }

    return {
      inefficiencies,
      totalWasteTokens,
      cachedContents,
      cleanMessages: windowResult.messages,
      autoOptimized: !!effectiveConfig.autoOptimize,
      deduplicationsApplied
    };
  }
}

const MODEL_LIMITS: Record<string, number> = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'claude-3-opus': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-haiku': 200000,
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-flash': 1000000,
};

export class ContextWindowManager {
  static getLimitForModel(model: string): number {
    for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
      if (model.toLowerCase().includes(key)) {
        return limit;
      }
    }
    return 128000; // Safe default
  }

  static fitToBudget(messages: any[], model: string, explicitBudget?: number, config?: TokenWallConfig): { messages: any[], warnings: string[] } {
    if (!messages || messages.length <= 2) return { messages, warnings: [] };

    const totalLimit = explicitBudget || this.getLimitForModel(model);
    const softLimit = totalLimit * 0.8;
    const lightPruneLimit = totalLimit * 0.95;
    const rollingLimit = totalLimit * 1.0;
    const aggressiveLimit = totalLimit * 1.1;

    let currentTokens = 0;
    const tokenCounts = messages.map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const count = countTokens(content, model);
      currentTokens += count;
      return count;
    });

    const warnings: string[] = [];

    if (currentTokens < softLimit) {
      return { messages, warnings };
    }

    warnings.push(`[TokenWall] Context size (${currentTokens} tokens) exceeded soft budget (${softLimit} tokens).`);

    let prunedMessages = JSON.parse(JSON.stringify(messages));
    
    const systemIndices = prunedMessages.map((m: any, i: number) => m.role === 'system' ? i : -1).filter((i: number) => i !== -1);
    const lastUserIndex = prunedMessages.map((m: any, i: number) => m.role === 'user' ? i : -1).reverse()[0];
    const preserveIndices = new Set([...systemIndices]);
    if (lastUserIndex !== undefined) preserveIndices.add(lastUserIndex);

    const importanceEngine = new ImportanceEngine();
    const policy = config?.importance?.policy || 'balanced';
    const threshold = ImportanceEngine.getThresholdForPolicy(policy);
    const messageScores = prunedMessages.map((m: any) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      // We take the average score of all lines in the message
      const lines = content.split('\n');
      if (lines.length === 0) return 0.5;
      let total = 0;
      for (const line of lines) {
        total += importanceEngine.scoreLine(line, { isLog: false, isCodeBlock: false, isStructuredData: false });
      }
      return total / lines.length;
    });

    // Light Pruning: drop messages below importance threshold or if they are huge old outputs
    if (currentTokens >= lightPruneLimit) {
      warnings.push(`[TokenWall] Light pruning activated. Dropping low-importance / huge old outputs.`);
      for (let i = 0; i < prunedMessages.length; i++) {
        const isHuge = tokenCounts[i] > 2000 && i < prunedMessages.length - 3;
        const isLowImportance = messageScores[i] < threshold;
        
        if (!preserveIndices.has(i) && (isHuge || isLowImportance)) {
          prunedMessages[i].content = isLowImportance ? '[TokenWall: Low-importance message pruned]' : '[TokenWall: Old huge context pruned]';
          currentTokens -= tokenCounts[i];
          tokenCounts[i] = 10;
        }
      }
    }

    // Rolling Window
    if (currentTokens >= rollingLimit) {
      warnings.push(`[TokenWall] Rolling window activated. Dropping oldest messages.`);
      for (let i = 0; i < prunedMessages.length; i++) {
        if (currentTokens <= rollingLimit) break;
        if (!preserveIndices.has(i) && prunedMessages[i].content !== '[TokenWall: Old huge context pruned]') {
           prunedMessages[i].content = '[TokenWall: Old message evicted to fit budget]';
           currentTokens -= tokenCounts[i];
           tokenCounts[i] = 10;
        }
      }
    }

    // Aggressive Pruning
    if (currentTokens >= aggressiveLimit) {
      warnings.push(`[TokenWall] Aggressive pruning activated. Preserving only system and recent context.`);
      for (let i = 0; i < prunedMessages.length; i++) {
        if (currentTokens <= totalLimit) break;
        if (!preserveIndices.has(i)) {
           prunedMessages[i].content = '[TokenWall: Aggressively evicted]';
           currentTokens -= tokenCounts[i];
           tokenCounts[i] = 5;
        }
      }
    }

    return { messages: prunedMessages, warnings };
  }
}
