import { countTokens } from '@tokenwall/estimators';
import { ToolSchemaOptimizer } from './tools';

export class ToolPruner {
  /**
   * Prunes obviously irrelevant tools from the request payload based on safe heuristics.
   * Modifies the requestBody in-place and returns the number of tokens saved.
   */
  static pruneTools(
    provider: 'openai' | 'anthropic' | 'gemini',
    requestBody: any,
    model: string,
    conversationContext: string
  ): number {
    let toolsArray: any[] = [];
    
    if (provider === 'openai' || provider === 'anthropic') {
      toolsArray = requestBody.tools || [];
    } else if (provider === 'gemini') {
      toolsArray = requestBody.tools?.[0]?.functionDeclarations || [];
    }

    if (!toolsArray || toolsArray.length === 0) {
      return 0;
    }

    const originalTokens = countTokens(JSON.stringify(toolsArray), model);
    const contextLower = conversationContext.toLowerCase();
    const aggressive = originalTokens > 2000;
    
    // SAFE HEURISTICS (Option A)
    // 1. Browser/Web tools
    const needsBrowser = /web|browser|http|https|url|search|navigate|google/i.test(contextLower);
    // 2. Command execution tools
    const needsBash = /run|execute|bash|shell|command|npm|yarn|build|test|start|script|make|gcc/i.test(contextLower);
    // 3. Database / SQL tools
    const needsDb = /sql|database|postgres|mysql|query|db|table|row/i.test(contextLower);

    const shouldPruneBlocklist = (toolName: string): boolean => {
      const name = toolName.toLowerCase();
      if (!needsBrowser && (name.includes('browser') || name.includes('puppeteer') || name.includes('web_search'))) return true;
      if (!needsBash && (name.includes('execute_command') || name.includes('bash') || name.includes('run_script'))) return true;
      if (!needsDb && (name.includes('sql') || name.includes('database') || name.includes('query_db'))) return true;
      return false;
    };

    const isCoreTool = (toolName: string): boolean => {
       const name = toolName.toLowerCase();
       return ['search', 'read', 'write', 'execute', 'bash', 'run', 'edit', 'view', 'ask', 'answer', 'mcp'].some(k => name.includes(k));
    };

    let prunedArray = toolsArray.filter(t => {
      const name = provider === 'openai' ? t.function?.name : (provider === 'gemini' ? t.name : t.name);
      const toolName = name || '';
      
      // Pass 1: Domain blocklist
      if (shouldPruneBlocklist(toolName)) return false;

      // Pass 2: Router allowlist (if many tools)
      if (toolsArray.length >= 10 && !isCoreTool(toolName)) {
        const toolKeywords = toolName.split(/[_.-]/);
        const matchesContext = toolKeywords.some((kw: string) => kw.length > 3 && contextLower.includes(kw));
        if (!matchesContext) return false;
      }
      return true;
    });
    
    if (provider === 'gemini') {
       prunedArray = ToolSchemaOptimizer.optimize(prunedArray, aggressive);
       if (requestBody.tools && requestBody.tools.length > 0) {
          requestBody.tools[0].functionDeclarations = prunedArray;
       }
    } else {
       prunedArray = ToolSchemaOptimizer.optimize(prunedArray, aggressive);
       requestBody.tools = prunedArray;
    }

    const prunedTokens = countTokens(JSON.stringify(prunedArray), model);
    return Math.max(0, originalTokens - prunedTokens);
  }
}
