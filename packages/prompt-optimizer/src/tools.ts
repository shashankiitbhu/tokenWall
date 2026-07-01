import { countTokens } from '@tokenwall/estimators';

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

  static optimizeToolResult(content: string, model: string): string {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 5) {
        const crushed = this.crushArray(parsed, 50, 1500, model);
        return JSON.stringify(crushed);
      } else if (typeof parsed === 'object' && parsed !== null) {
        // Find massive arrays inside the object
        let mutated = false;
        for (const [key, val] of Object.entries(parsed)) {
          if (Array.isArray(val) && val.length > 5) {
            parsed[key] = this.crushArray(val, 50, 1500, model);
            mutated = true;
          }
        }
        if (mutated) return JSON.stringify(parsed);
      }
    } catch (e) {
      // Not JSON, return as is
    }
    return content;
  }
}
