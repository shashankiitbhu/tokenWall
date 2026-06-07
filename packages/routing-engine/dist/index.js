"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelRouter = void 0;
const estimators_1 = require("@tokenwall/estimators");
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
const MODEL_QUALITY_MAP = {
    'gpt-4o': 'High',
    'gpt-4-turbo': 'High',
    'claude-3-opus': 'High',
    'claude-3-5-sonnet': 'Medium-High',
    'claude-3-5-sonnet-20241022': 'Medium-High',
    'gemini-1.5-pro': 'Medium-High',
    'gpt-4o-mini': 'Medium',
    'claude-3-5-haiku': 'Medium',
    'claude-3-haiku': 'Medium',
    'gemini-1.5-flash': 'Medium',
    'gemini-2.0-flash': 'Medium'
};
function getQualityLevel(model) {
    for (const key of Object.keys(MODEL_QUALITY_MAP)) {
        if (model.includes(key))
            return MODEL_QUALITY_MAP[key];
    }
    return 'Medium'; // default fallback
}
class ModelRouter {
    classifyComplexity(req) {
        const combinedContent = req.messages.map(m => m.content).join(' ');
        const tokens = (0, estimators_1.countTokens)(combinedContent, req.model);
        // Context size checks
        if (tokens > 40000 || req.toolsAttached) {
            return 'high';
        }
        // Keyword matching
        let lowCount = 0;
        for (const regex of LOW_COMPLEXITY_KEYWORDS) {
            if (regex.test(combinedContent))
                lowCount++;
        }
        let highCount = 0;
        for (const regex of HIGH_COMPLEXITY_KEYWORDS) {
            if (regex.test(combinedContent))
                highCount++;
        }
        if (highCount > 0)
            return 'high';
        if (lowCount >= 2 || (lowCount >= 1 && tokens < 2000))
            return 'low';
        return 'medium';
    }
    calcCost(inputTokens, expectedOutputTokens, pricing) {
        return ((inputTokens / 1000000) * pricing.inputPerMillion) +
            ((expectedOutputTokens / 1000000) * pricing.outputPerMillion);
    }
    generateRoutingOptions(req, inputTokens, expectedOutputTokens) {
        const complexity = this.classifyComplexity(req);
        const currentModel = req.model;
        const currentPricing = (0, estimators_1.getPricingForModel)(currentModel);
        const originalCost = this.calcCost(inputTokens, expectedOutputTokens, currentPricing);
        const alternatives = [];
        let explanation = 'Your selected model is appropriate for this task.';
        let shouldRoute = false;
        // Build curated list of alternatives depending on provider to not confuse user
        const ecosystem = currentModel.includes('claude') ? 'anthropic' : (currentModel.includes('gemini') ? 'gemini' : 'openai');
        let candidateModels = [];
        if (ecosystem === 'anthropic') {
            candidateModels = ['claude-3-opus', 'claude-3-5-sonnet', 'claude-3-5-haiku'];
        }
        else if (ecosystem === 'gemini') {
            candidateModels = ['gemini-1.5-pro', 'gemini-1.5-flash'];
        }
        else {
            candidateModels = ['gpt-4o', 'gpt-4o-mini'];
        }
        for (const altModel of candidateModels) {
            const pricing = (0, estimators_1.getPricingForModel)(altModel);
            const cost = this.calcCost(inputTokens, expectedOutputTokens, pricing);
            const savingsPercentage = originalCost > 0 ? Math.round(((originalCost - cost) / originalCost) * 100) : 0;
            alternatives.push({
                model: altModel,
                estimatedCost: cost,
                qualityLevel: getQualityLevel(altModel),
                savingsPercentage
            });
        }
        // Determine if we should actively route
        const currentQuality = getQualityLevel(currentModel);
        if (currentQuality === 'High' && complexity === 'low') {
            shouldRoute = true;
            explanation = `Low complexity task detected. Consider switching from ${currentModel} to a cheaper alternative to save cost.`;
        }
        else if (currentModel.includes('opus') && complexity === 'medium') {
            shouldRoute = true;
            explanation = `Medium complexity task. Claude Sonnet offers equivalent coding skills for 80% less cost.`;
        }
        return {
            complexity,
            shouldRoute,
            originalModel: currentModel,
            originalEstimatedCost: originalCost,
            alternatives,
            explanation
        };
    }
}
exports.ModelRouter = ModelRouter;
