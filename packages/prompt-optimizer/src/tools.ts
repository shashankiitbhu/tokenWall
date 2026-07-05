import { countTokens } from '@tokenwall/estimators';
import * as crypto from 'crypto';

// --- Tool Router ---
export class ToolRouter {
  /**
   * Drops irrelevant tools if the number of tools exceeds a threshold (e.g. 15).
   * It uses lightweight keyword matching against the user's prompt.
   */
  static route(tools: any[], messages: any[]): any[] {
    if (!tools || tools.length < 15) return tools;
    
    // Extract recent user context
    const recentContext = messages
      .filter(m => m.role === 'user' || m.role === 'system')
      .slice(-3)
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join(' ')
      .toLowerCase();
      
    return tools.filter(tool => {
      // Always keep very common/fundamental tools that might be implied
      const name = tool.function?.name || tool.name || '';
      if (['search', 'read', 'write', 'execute', 'bash', 'run'].some(k => name.toLowerCase().includes(k))) {
        return true;
      }
      
      // Keep if the tool name or core keywords appear in the context
      const toolKeywords = name.toLowerCase().split(/[_.-]/);
      return toolKeywords.some((kw: string) => kw.length > 3 && recentContext.includes(kw));
    });
  }
}

// --- Tool Schema Optimizer ---
export class ToolSchemaOptimizer {
  /**
   * Cleans up tautological zero-information descriptions
   */
  static isTautological(name: string, description: string): boolean {
    if (!description || !name) return false;
    const desc = description.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (desc === nm || desc === `the${nm}`) return true;
    return false;
  }

  /**
   * Truncates description to first sentence, preserving constraints.
   */
  static truncateDescription(desc: string, aggressive: boolean): string {
    if (!desc) return desc;
    // Don't truncate if it has obvious constraint keywords
    if (/must|never|always|only|required|cannot|do not/i.test(desc)) {
      return desc;
    }
    
    if (aggressive) {
      // Aggressive: keep first sentence
      const match = desc.match(/^.*?[.!?](?:\s|$)/);
      if (match) return match[0].trim();
    }
    
    return desc;
  }

  static optimizeSchemaNode(node: any, aggressive: boolean = false) {
    if (!node || typeof node !== 'object') return;
    
    if (node.properties) {
      for (const [key, prop] of Object.entries<any>(node.properties)) {
        if (prop.description) {
          if (this.isTautological(key, prop.description)) {
            delete prop.description;
          } else {
            prop.description = this.truncateDescription(prop.description, aggressive);
          }
        }
        this.optimizeSchemaNode(prop, aggressive);
      }
    }
    
    if (node.items) {
      this.optimizeSchemaNode(node.items, aggressive);
    }
  }

  static optimize(tools: any[], aggressive: boolean = false): any[] {
    if (!tools || !Array.isArray(tools)) return tools;
    
    const newTools = JSON.parse(JSON.stringify(tools));
    for (const tool of newTools) {
      // Find the function definition based on schema type
      const func = tool.function || tool;
      
      if (func.description) {
        func.description = this.truncateDescription(func.description, aggressive);
      }
      
      if (func.parameters) {
        this.optimizeSchemaNode(func.parameters, aggressive);
      } else if (func.input_schema) { // Anthropic format
        this.optimizeSchemaNode(func.input_schema, aggressive);
      }
    }
    return newTools;
  }
}

import { CachedContent } from './code-compressor';

// --- Tool Payload Crusher ---
export class ToolPayloadCrusher {
  /**
   * Detects if an array is homogeneous (objects with identical keys and primitive values)
   */
  static isHomogeneous(arr: any[]): boolean {
    if (arr.length < 5) return false;
    const keySets = arr.slice(0, Math.min(arr.length, 10)).map(item => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // If any value is a nested object/array, we cannot easily CSV it
        if (Object.values(item).some(v => typeof v === 'object' && v !== null)) {
          return 'NESTED';
        }
        return Object.keys(item).sort().join(',');
      }
      return 'PRIMITIVE';
    });
    
    const firstKeys = keySets[0];
    if (firstKeys === 'NESTED' || firstKeys === 'PRIMITIVE') return false;
    return keySets.every(keys => keys === firstKeys);
  }

  static convertToCSV(arr: any[]): string {
    const keys = Object.keys(arr[0]).sort();
    const rows = [keys.join(',')];
    for (const item of arr) {
      const row = keys.map(k => {
        let val = item[k];
        if (val === null || val === undefined) val = '';
        const valStr = String(val);
        if (valStr.includes(',') || valStr.includes('"') || valStr.includes('\n')) {
          return `"${valStr.replace(/"/g, '""')}"`;
        }
        return valStr;
      });
      rows.push(row.join(','));
    }
    return rows.join('\n');
  }

  static crushArray(arr: any[], maxItems: number, maxTokens: number, model: string): any[] {
    if (arr.length <= maxItems) {
      const tokenCount = countTokens(JSON.stringify(arr), model);
      if (tokenCount <= maxTokens) return arr;
    }

    if (this.isHomogeneous(arr)) {
      const csvStr = this.convertToCSV(arr);
      return [`[TokenWall: SQL/Array converted to CSV for context optimization]`, csvStr];
    }

    // Try keeping head and tail
    const keepCount = Math.min(arr.length, maxItems);
    const headCount = Math.floor(keepCount / 2);
    const tailCount = keepCount - headCount;
    
    const head = arr.slice(0, headCount);
    const tail = arr.slice(arr.length - tailCount);
    const truncatedCount = arr.length - keepCount;

    const metadataNode = `... [TokenWall: ${truncatedCount} items truncated for context optimization] ...`;
    
    const candidate = [...head, metadataNode, ...tail];
    const candidateTokens = countTokens(JSON.stringify(candidate), model);
    
    if (candidateTokens <= maxTokens) {
      return candidate;
    }
    
    // If still too large token-wise, fall back to pure head extraction to satisfy token constraints
    let currentTokens = countTokens(JSON.stringify([metadataNode]), model);
    const aggressiveHead = [];
    for (const item of arr) {
      const itemTokens = countTokens(JSON.stringify(item), model);
      if (currentTokens + itemTokens > maxTokens) break;
      aggressiveHead.push(item);
      currentTokens += itemTokens;
    }
    
    return [...aggressiveHead, metadataNode];
  }

  static optimizeToolResult(
    content: string, 
    model: string, 
    outCachedContents: CachedContent[] = [],
    sessionId?: string,
    dedupMap?: Map<string, { turnIndex: number, cacheId: string }>,
    turnIndex?: number
  ): string {
    // 1. ANSI Escape Code Stripping
    const noAnsi = content.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = noAnsi.split('\n');

    // 2. Threshold Check & Deduplication
    // Critical Note: Do NOT migrate deduplication to an args-based check (e.g. matching tool name + args).
    // A mutable query like `read_file` can return different content on the same path if the file was edited in between.
    // Content-based hashing handles this correctly for free and prevents state drift.
    let contentId = '';
    
    if (lines.length > 100 || noAnsi.length > 4000) {
      if (sessionId && dedupMap && turnIndex !== undefined) {
        // Compute truncated SHA-256 hash (16 bytes / 32 hex chars) of raw pre-pruned content
        const hash = crypto.createHash('sha256').update(noAnsi).digest('hex').substring(0, 32);
        contentId = `ccr_txt_${sessionId}_${hash}`;

        if (dedupMap.has(hash)) {
          const { turnIndex: firstTurn, cacheId } = dedupMap.get(hash)!;
          return `[Tool Output: identical to Message ${firstTurn}, content_id='${cacheId}']`;
        } else {
          dedupMap.set(hash, { turnIndex, cacheId: contentId });
        }
      } else {
        // Fallback random ID if tracking is unavailable
        contentId = `ccr_txt_${Math.random().toString(36).substring(2, 9)}`;
      }
    }

    // Attempt standard JSON parsing
    try {
      const parsed = JSON.parse(content);
      const crushed = this.processJsonObject(parsed, model);
      if (contentId) {
        outCachedContents.push({ id: contentId, content: noAnsi });
      }
      return crushed;
    } catch (e) {
      // Not standard JSON
    }

    // Attempt JSONL parsing
    try {
      if (lines.length > 5) {
        const parsedLines = lines.map(line => JSON.parse(line));
        // It's valid JSONL! Treat it like an array.
        const crushed = this.crushArray(parsedLines, 50, 1500, model);
        const crushedStr = crushed.map(item => typeof item === 'string' && item.startsWith('... [TokenWall') ? item : JSON.stringify(item)).join('\n');
        if (contentId) {
          outCachedContents.push({ id: contentId, content: noAnsi });
        }
        return crushedStr;
      }
    } catch (e) {
      // Not JSONL
    }

    // --- Raw Text Processing ---
    
    if (!contentId) {
      // It was below threshold
      return noAnsi; // Use stripped text to save tokens
    }

    // 3. Security Redaction
    const redacted = this.redactText(noAnsi);
    const redactedLines = redacted.split('\n');

    // 4. Cache Full Redacted Text
    outCachedContents.push({ id: contentId, content: redacted });

    // 5. Relevance-Based Pruning
    const highSignalRegex = /fatal|panic|error|exception|fail|traceback|warning/i;
    const matches: { index: number, severity: number }[] = [];

    for (let i = 0; i < redactedLines.length; i++) {
      const line = redactedLines[i];
      const match = line.match(highSignalRegex);
      if (match) {
        let severity = 1; // warning
        if (/error|exception|fail|traceback/i.test(match[0])) severity = 2;
        if (/fatal|panic/i.test(match[0])) severity = 3;
        matches.push({ index: i, severity });
      }
    }

    if (matches.length > 0) {
      // Enforce Blowup Cap
      // Sort matches by severity (descending) then by index (descending - favor tail)
      matches.sort((a, b) => {
        if (a.severity !== b.severity) return b.severity - a.severity;
        return b.index - a.index;
      });

      // Keep top N matches (e.g. max 50 lines total -> roughly 5 matches with ±5 context)
      const topMatches = matches.slice(0, 5).map(m => m.index);
      topMatches.sort((a, b) => a - b); // restore chronological order

      const ranges: [number, number][] = [];
      // Always include head and tail (10 lines each)
      ranges.push([0, Math.min(9, redactedLines.length - 1)]);
      ranges.push([Math.max(0, redactedLines.length - 10), redactedLines.length - 1]);

      for (const idx of topMatches) {
        ranges.push([Math.max(0, idx - 5), Math.min(redactedLines.length - 1, idx + 5)]);
      }

      const mergedRanges = this.mergeRanges(ranges);
      
      const outputParts: string[] = [];
      let lastEnd = -1;

      for (const [start, end] of mergedRanges) {
        if (start > lastEnd + 1 && lastEnd !== -1) {
          const omitted = start - lastEnd - 1;
          outputParts.push(`\n... [TokenWall: ${omitted} lines truncated. Use tokenwall_retrieve_content tool with content_id='${contentId}'] ...\n`);
        }
        outputParts.push(redactedLines.slice(start, end + 1).join('\n'));
        lastEnd = end;
      }

      return outputParts.join('\n');
    }

    // 6. Fallback Positional Pruning
    const headLines = redactedLines.slice(0, 30);
    const tailLines = redactedLines.slice(-30);
    const omittedCount = redactedLines.length - 60;
    
    return [
      ...headLines,
      `\n... [TokenWall: ${omittedCount} lines truncated — no error/warning markers detected in omitted region. Use tokenwall_retrieve_content tool with content_id='${contentId}'] ...\n`,
      ...tailLines
    ].join('\n');
  }

  private static processJsonObject(parsed: any, model: string): string {
    if (Array.isArray(parsed) && parsed.length > 5) {
      const crushed = this.crushArray(parsed, 50, 1500, model);
      return JSON.stringify(crushed);
    } else if (typeof parsed === 'object' && parsed !== null) {
      let mutated = false;
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val) && val.length > 5) {
          parsed[key] = this.crushArray(val, 50, 1500, model);
          mutated = true;
        }
      }
      if (mutated) return JSON.stringify(parsed);
    }
    return JSON.stringify(parsed);
  }

  private static redactText(text: string): string {
    let redacted = text;
    // Known Regex Formats
    redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
    redacted = redacted.replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, 'Bearer [REDACTED_TOKEN]');
    redacted = redacted.replace(/postgres:\/\/[^:]+:[^@]+@/gi, 'postgres://[REDACTED_USER]:[REDACTED_PASS]@');
    
    // Entropy Pass (High-entropy strings > 40 chars)
    // Matches long base64/hex strings
    redacted = redacted.replace(/[a-zA-Z0-9\-_]{40,}/g, (match) => {
      // Simple heuristic: if it looks like a hash or token, redact it
      if (match.length >= 40 && !match.match(/^[0-9]+$/)) { // Not just a massive number
         return '[REDACTED_HIGH_ENTROPY_STRING]';
      }
      return match;
    });

    return redacted;
  }

  private static mergeRanges(ranges: [number, number][]): [number, number][] {
    if (ranges.length === 0) return [];
    // Sort by start index
    ranges.sort((a, b) => a[0] - b[0]);
    
    const merged: [number, number][] = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const current = ranges[i];
      const last = merged[merged.length - 1];
      
      // If ranges overlap or are exactly adjacent, merge them
      if (current[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], current[1]);
      } else {
        merged.push(current);
      }
    }
    return merged;
  }
}
