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
    
    // SAFE HEURISTICS (Option A)
    // We only prune tools if we are highly confident the user/agent is not asking for that domain of work.
    
    // 1. Browser/Web tools
    const needsBrowser = /web|browser|http|https|url|search|navigate|google/i.test(contextLower);
    
    // 2. Command execution tools
    const needsBash = /run|execute|bash|shell|command|npm|yarn|build|test|start|script|make|gcc/i.test(contextLower);
    
    // 3. Database / SQL tools
    const needsDb = /sql|database|postgres|mysql|query|db|table|row/i.test(contextLower);

    const shouldPrune = (toolName: string): boolean => {
      const name = toolName.toLowerCase();
      
      if (!needsBrowser && (name.includes('browser') || name.includes('puppeteer') || name.includes('web_search'))) {
        return true;
      }
      
      if (!needsBash && (name.includes('execute_command') || name.includes('bash') || name.includes('run_script'))) {
        return true;
      }

      if (!needsDb && (name.includes('sql') || name.includes('database') || name.includes('query_db'))) {
        return true;
      }
      
      // Never prune core file editing/reading tools to be safe
      return false;
    };

    let prunedArray = toolsArray;
    
    if (provider === 'gemini') {
       prunedArray = toolsArray.filter(t => !shouldPrune(t.name));
       prunedArray = ToolSchemaOptimizer.optimize(prunedArray, false);
       if (requestBody.tools && requestBody.tools.length > 0) {
          requestBody.tools[0].functionDeclarations = prunedArray;
       }
    } else {
       prunedArray = toolsArray.filter(t => {
         const name = provider === 'openai' ? t.function?.name : t.name;
         return !shouldPrune(name || '');
       });
       prunedArray = ToolSchemaOptimizer.optimize(prunedArray, false);
       requestBody.tools = prunedArray;
    }

    const prunedTokens = countTokens(JSON.stringify(prunedArray), model);
    return Math.max(0, originalTokens - prunedTokens);
  }
}
