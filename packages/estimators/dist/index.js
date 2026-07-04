"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRICING_DIRECTORY = void 0;
exports.countTokens = countTokens;
exports.estimateRequestTokens = estimateRequestTokens;
exports.getPricingForModel = getPricingForModel;
exports.calculatePreFlightEstimation = calculatePreFlightEstimation;
const js_tiktoken_1 = require("js-tiktoken");
__exportStar(require("./attribution"), exports);
exports.PRICING_DIRECTORY = {
    // Anthropic 2026 Models
    'claude-fable-5': { inputPerMillion: 10.00, outputPerMillion: 50.00, contextWindow: 1000000 },
    'claude-opus-4-8': { inputPerMillion: 5.00, outputPerMillion: 25.00, contextWindow: 1000000 },
    'claude-sonnet-4-6': { inputPerMillion: 3.00, outputPerMillion: 15.00, contextWindow: 1000000 },
    'claude-haiku-4-5': { inputPerMillion: 1.00, outputPerMillion: 5.00, contextWindow: 200000 },
    // Anthropic Legacy/Prior Generation
    'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00, contextWindow: 200000 },
    'claude-3-5-haiku': { inputPerMillion: 0.80, outputPerMillion: 4.00, contextWindow: 200000 },
    'claude-3-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00, contextWindow: 200000 },
    'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25, contextWindow: 200000 },
    // OpenAI 2026 Models
    'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10.00, contextWindow: 128000 },
    'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2.00, contextWindow: 128000 },
    'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.40, contextWindow: 128000 },
    'o4-mini': { inputPerMillion: 1.10, outputPerMillion: 4.40, contextWindow: 128000 },
    'o3-pro': { inputPerMillion: 20.00, outputPerMillion: 80.00, contextWindow: 200000 },
    'o3': { inputPerMillion: 2.00, outputPerMillion: 8.00, contextWindow: 200000 },
    // OpenAI Legacy/Prior Generation
    'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00, contextWindow: 128000 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60, contextWindow: 128000 },
    'gpt-4-turbo': { inputPerMillion: 10.00, outputPerMillion: 30.00, contextWindow: 128000 },
    'gpt-3.5-turbo': { inputPerMillion: 0.50, outputPerMillion: 1.50, contextWindow: 16385 },
    // Gemini 2026 Models
    'gemini-3.5-flash': { inputPerMillion: 0.75, outputPerMillion: 4.50, contextWindow: 1000000 },
    'gemini-3.1-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00, contextWindow: 2000000 },
    'gemini-2.5-flash-lite': { inputPerMillion: 0.10, outputPerMillion: 0.40, contextWindow: 1000000 },
    'gemini-2.5-flash': { inputPerMillion: 0.30, outputPerMillion: 2.50, contextWindow: 1000000 },
    // Gemini Legacy/Prior Generation
    'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00, contextWindow: 1000000 },
    'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30, contextWindow: 1000000 }
};
const gpt4oTokenizer = (0, js_tiktoken_1.getEncoding)('o200k_base');
const defaultTokenizer = (0, js_tiktoken_1.getEncoding)('cl100k_base');
function countTokens(text, model) {
    try {
        if (model.includes('gpt-4o') || model.includes('gpt-5')) {
            return gpt4oTokenizer.encode(text).length;
        }
        return defaultTokenizer.encode(text).length;
    }
    catch {
        // Basic approximation: 1 token ~= 4 characters or 0.75 words
        return Math.ceil(text.length / 4);
    }
}
function estimateRequestTokens(req) {
    let total = 0;
    if (req.systemInstruction) {
        total += countTokens(req.systemInstruction, req.model);
    }
    if (req.toolsSchemaText) {
        total += countTokens(req.toolsSchemaText, req.model);
    }
    for (const msg of req.messages) {
        total += countTokens(msg.content, req.model);
        total += 4; // message packaging overhead
    }
    return total;
}
function getPricingForModel(modelName) {
    const nameLower = modelName.toLowerCase();
    const normalized = Object.keys(exports.PRICING_DIRECTORY).find(key => {
        if (nameLower.includes(key))
            return true;
        // Loose keyword matching
        if (key.includes('opus') && nameLower.includes('opus'))
            return true;
        if (key.includes('sonnet') && nameLower.includes('sonnet'))
            return true;
        if (key.includes('haiku') && nameLower.includes('haiku'))
            return true;
        if (key.includes('fable') && nameLower.includes('fable'))
            return true;
        if (key.includes('gpt-5') && nameLower.includes('gpt-5'))
            return true;
        if (key.includes('gpt-4o') && nameLower.includes('gpt-4o'))
            return true;
        return false;
    });
    return exports.PRICING_DIRECTORY[normalized || 'gemini-3.5-flash'];
}
function calculatePreFlightEstimation(req, history = []) {
    const pricing = getPricingForModel(req.model);
    const inputTokens = estimateRequestTokens(req);
    // Predict expected output tokens
    let expectedOutput = req.maxTokens;
    if (!expectedOutput) {
        if (history.length > 0) {
            const avgOutput = history.reduce((sum, h) => sum + h.output, 0) / history.length;
            expectedOutput = Math.min(1200, Math.ceil(avgOutput * 1.15));
        }
        else {
            // If agent prompt has tools, it will likely output compact tool calls, but loop
            expectedOutput = req.toolsAttached ? 400 : 800;
        }
    }
    // Cost formula
    const inputCost = (inputTokens / 1000000) * pricing.inputPerMillion;
    const outputCost = (expectedOutput / 1000000) * pricing.outputPerMillion;
    let baseCost = inputCost + outputCost;
    // Multi-step tool / autonomous amplification
    let amplificationFactor = 1.0;
    let confidence = 0.90;
    let amplificationReason;
    if (req.toolsAttached) {
        // Autonomous loop simulation (expecting ~3 sequential tool-use iterations)
        amplificationFactor = 2.5;
        confidence = 0.70;
        amplificationReason = 'Agent tools attached. Amplified for expected multi-step execution loop.';
    }
    // Model-specific failure / retry inflation
    const isMiniModel = req.model.includes('mini') || req.model.includes('flash');
    if (isMiniModel && req.toolsAttached) {
        amplificationFactor *= 1.25; // Mini models tend to require more retries for structured tools
        amplificationReason = 'Agent tools on a mini model. Inflated for potential retry loops.';
    }
    const finalCost = baseCost * amplificationFactor;
    return {
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: expectedOutput,
        estimatedCost: Math.max(0.0001, parseFloat(finalCost.toFixed(6))),
        confidence,
        pricing,
        amplificationReason
    };
}
