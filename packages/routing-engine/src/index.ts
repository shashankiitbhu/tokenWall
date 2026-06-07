import { NormalizedRequest } from '@tokenwall/providers';
import { countTokens, getPricingForModel } from '@tokenwall/estimators';

export type TaskComplexity = 'low' | 'medium' | 'high';

export interface RouteRecommendation {
  complexity: TaskComplexity;
  shouldRoute: boolean;
  recommendedModel: string;
  originalEstimatedCost: number;
  newEstimatedCost: number;
  savingsPercentage: number;
  explanation: string;
}

const LOW_COMPLEXITY_KEYWORDS = [
  /\btypo\b/i, /\blint\b/i, /\bprettier\b/i, /\beslint\b/i, /\bcomment\b/i,
  /\bformatting\b/i, /\brename\b/i, /\bdelete file\b/i, /\bmove file\b/i,
  /\bhow do I print\b/i, /\bsyntax\b/i, /\bwhat does this line do\b/i
];

const HIGH_COMPLEXITY_KEYWORDS = [
  /\barchitect\b/i, /\brefactor\b/i, /\bdesign pattern\b/i, /\bmemory leak\b/i,
  /\brace condition\b/i, /\bsecurity vulnerability\b/i, /\bperformance tuning\b/i,
  /\boptimize query\b/i, /\bexplain how this entire repository\b/i, /\bdeeply reason\b/i
];

export class ModelRouter {
  classifyComplexity(req: NormalizedRequest): TaskComplexity {
    const combinedContent = req.messages.map(m => m.content).join(' ');
    const tokens = countTokens(combinedContent, req.model);

    // Context size checks
    if (tokens > 40000 || req.toolsAttached) {
      return 'high';
    }

    // Keyword matching
    let lowCount = 0;
    for (const regex of LOW_COMPLEXITY_KEYWORDS) {
      if (regex.test(combinedContent)) lowCount++;
    }

    let highCount = 0;
    for (const regex of HIGH_COMPLEXITY_KEYWORDS) {
      if (regex.test(combinedContent)) highCount++;
    }

    if (highCount > 0) return 'high';
    if (lowCount >= 2 || (lowCount >= 1 && tokens < 2000)) return 'low';

    return 'medium';
  }

  recommendRoute(req: NormalizedRequest, inputTokens: number, expectedOutputTokens: number): RouteRecommendation {
    const complexity = this.classifyComplexity(req);
    const currentModel = req.model;
    const currentPricing = getPricingForModel(currentModel);
    
    const originalCost = ((inputTokens / 1000000) * currentPricing.inputPerMillion) + 
                          ((expectedOutputTokens / 1000000) * currentPricing.outputPerMillion);

    let recommendedModel = currentModel;
    let explanation = 'Your selected model is appropriate for this task.';
    let shouldRoute = false;

    // Check if we can route to a cheaper model
    const isPremiumModel = currentModel.includes('opus') || 
                           currentModel.includes('sonnet') || 
                           currentModel.includes('gpt-4o') || 
                           currentModel.includes('pro');

    if (isPremiumModel && complexity === 'low') {
      shouldRoute = true;
      if (currentModel.includes('claude')) {
        recommendedModel = 'claude-3-5-haiku';
        explanation = 'Low complexity task detected. Switched Claude Sonnet to Haiku to save cost.';
      } else if (currentModel.includes('gpt')) {
        recommendedModel = 'gpt-4o-mini';
        explanation = 'Low complexity task detected. Switched GPT-4o to GPT-4o-mini to save cost.';
      } else if (currentModel.includes('gemini')) {
        recommendedModel = 'gemini-1.5-flash';
        explanation = 'Low complexity task detected. Switched Gemini Pro to Gemini Flash to save cost.';
      }
    } else if (currentModel.includes('opus') && complexity === 'medium') {
      shouldRoute = true;
      recommendedModel = 'claude-3-5-sonnet';
      explanation = 'Medium complexity task. Switched Claude Opus to Claude Sonnet (equivalent coding skills, 80% cheaper).';
    }

    const recommendedPricing = getPricingForModel(recommendedModel);
    const newCost = ((inputTokens / 1000000) * recommendedPricing.inputPerMillion) + 
                    ((expectedOutputTokens / 1000000) * recommendedPricing.outputPerMillion);

    const savingsPercentage = originalCost > 0 ? Math.round(((originalCost - newCost) / originalCost) * 100) : 0;

    return {
      complexity,
      shouldRoute,
      recommendedModel,
      originalEstimatedCost: originalCost,
      newEstimatedCost: newCost,
      savingsPercentage,
      explanation
    };
  }
}
