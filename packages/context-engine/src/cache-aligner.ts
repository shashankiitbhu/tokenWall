import * as crypto from 'crypto';

export interface CacheAlignmentContext {
  prompt: string;
  role: string;
  isSystem: boolean;
  findings: any[];
  cacheabilityScore: number;
}

export interface CacheAlignerPlugin {
  name: string;
  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext;
}

export class WhitespaceNormalizationPlugin implements CacheAlignerPlugin {
  name = 'WhitespaceNormalizationPlugin';

  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext {
    // We want to normalize whitespace outside of code blocks and JSON.
    // A simple approach is to find ``` blocks, temporarily replace them, normalize the rest, and restore them.
    const codeBlocks: string[] = [];
    let tempText = context.prompt.replace(/```[\s\S]*?```/g, match => {
      codeBlocks.push(match);
      return `__TOKENWALL_CODEBLOCK_${codeBlocks.length - 1}__`;
    });

    // Normalize whitespace
    tempText = tempText
      .split(/\r?\n/)
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, i, arr) => {
        if (line === '') {
          return i > 0 && arr[i - 1].trim() !== '';
        }
        return true;
      })
      .join('\n')
      .trim();

    // Restore code blocks
    let finalPrompt = tempText.replace(/__TOKENWALL_CODEBLOCK_(\d+)__/g, (match, index) => {
      return codeBlocks[parseInt(index, 10)];
    });

    context.prompt = finalPrompt;
    return context;
  }
}

export class DeterministicJsonPlugin implements CacheAlignerPlugin {
  name = 'DeterministicJsonPlugin';

  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext {
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/ig;
    let finalPrompt = context.prompt.replace(jsonRegex, (match, jsonString) => {
      try {
        const parsed = JSON.parse(jsonString);
        const sortKeys = (obj: any): any => {
          if (Array.isArray(obj)) {
            return obj.map(sortKeys);
          } else if (obj !== null && typeof obj === 'object') {
            const sortedObj: any = {};
            Object.keys(obj).sort().forEach(key => {
              sortedObj[key] = sortKeys(obj[key]);
            });
            return sortedObj;
          }
          return obj;
        };
        return `\`\`\`json\n${JSON.stringify(sortKeys(parsed), null, 2)}\n\`\`\``;
      } catch (e) {
        return match; // If it's invalid JSON, leave it alone
      }
    });

    context.prompt = finalPrompt;
    return context;
  }
}

export class ToolSchemaSortPlugin implements CacheAlignerPlugin {
  name = 'ToolSchemaSortPlugin';

  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext {
    // This plugin doesn't touch the prompt directly.
    // It provides a static method to sort the tools array elsewhere.
    return context;
  }

  static sortTools(tools: any[]): any[] {
    if (!tools || !Array.isArray(tools)) return tools;

    const sortObjectKeys = (obj: any): any => {
      if (Array.isArray(obj)) return obj.map(sortObjectKeys);
      if (obj !== null && typeof obj === 'object') {
        const sorted: any = {};
        Object.keys(obj).sort().forEach(k => {
          sorted[k] = sortObjectKeys(obj[k]);
        });
        return sorted;
      }
      return obj;
    };

    const sortedTools = tools.map(sortObjectKeys);
    
    // Sort the tool array by tool name
    sortedTools.sort((a, b) => {
      const nameA = a.function?.name || a.name || '';
      const nameB = b.function?.name || b.name || '';
      return nameA.localeCompare(nameB);
    });

    return sortedTools;
  }
}

export class VolatileRelocationPlugin implements CacheAlignerPlugin {
  name = 'VolatileRelocationPlugin';

  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext {
    const isAggressive = options?.aggressiveCacheOptimization === true;
    
    const uuidRegex = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
    const iso8601Regex = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
    const jwtRegex = /\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;

    let totalVolatileTokens = 0;
    const relocatedValues: string[] = [];
    
    const relocate = (match: string, type: string) => {
      totalVolatileTokens += Math.ceil(match.length / 4); // rough approximation
      context.findings.push({ type, value: match });
      
      if (isAggressive) {
        relocatedValues.push(match);
        return `{{VOLATILE_${relocatedValues.length}}}`;
      }
      return match;
    };

    let p = context.prompt;
    p = p.replace(uuidRegex, (m) => relocate(m, 'uuid'));
    p = p.replace(iso8601Regex, (m) => relocate(m, 'iso8601'));
    // JWT has a high chance of false positive on filenames, so we do a quick length check
    p = p.replace(jwtRegex, (m) => {
      const parts = m.split('.');
      if (parts[0].length >= 4 && parts[1].length >= 4 && parts[2].length >= 4) {
        return relocate(m, 'jwt');
      }
      return m;
    });

    if (totalVolatileTokens > 0) {
      // Base score is 100. Lower it based on volatility.
      context.cacheabilityScore = Math.max(0, context.cacheabilityScore - (totalVolatileTokens * 2));
    }

    if (isAggressive && relocatedValues.length > 0) {
      // Append the map to the end
      p += '\n\n[TokenWall Relocated Variables]\n' + relocatedValues.map((v, i) => `{{VOLATILE_${i + 1}}}: ${v}`).join('\n');
    }

    context.prompt = p;
    return context;
  }
}

export class PromptFingerprintPlugin implements CacheAlignerPlugin {
  name = 'PromptFingerprintPlugin';

  apply(context: CacheAlignmentContext, options?: any): CacheAlignmentContext {
    const hash = crypto.createHash('sha256').update(context.prompt).digest('hex');
    context.findings.push({ type: 'fingerprint', value: hash });
    return context;
  }
}

export class CacheAlignerPipeline {
  private plugins: CacheAlignerPlugin[] = [];

  constructor() {
    this.plugins.push(new WhitespaceNormalizationPlugin());
    this.plugins.push(new DeterministicJsonPlugin());
    this.plugins.push(new ToolSchemaSortPlugin());
    this.plugins.push(new VolatileRelocationPlugin());
    this.plugins.push(new PromptFingerprintPlugin());
  }

  align(prompt: string, role: string, isSystem: boolean, options?: any): CacheAlignmentContext {
    let context: CacheAlignmentContext = {
      prompt,
      role,
      isSystem,
      findings: [],
      cacheabilityScore: 100
    };

    for (const plugin of this.plugins) {
      context = plugin.apply(context, options);
    }

    return context;
  }
}
