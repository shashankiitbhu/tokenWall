import { getEncoding } from 'js-tiktoken';
import { NormalizedRequest } from '@tokenwall/providers';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  contextWindow: number;
}

export const PRICING_DIRECTORY: Record<string, ModelPricing> = {
  // Anthropic
  'claude-3-5-sonnet': { inputPerMillion: 3.00, outputPerMillion: 15.00, contextWindow: 200000 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.00, outputPerMillion: 15.00, contextWindow: 200000 },
  'claude-3-5-haiku': { inputPerMillion: 0.80, outputPerMillion: 4.00, contextWindow: 200000 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.80, outputPerMillion: 4.00, contextWindow: 200000 },
  'claude-3-opus': { inputPerMillion: 15.00, outputPerMillion: 75.00, contextWindow: 200000 },
  'claude-3-opus-20240229': { inputPerMillion: 15.00, outputPerMillion: 75.00, contextWindow: 200000 },
  'claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25, contextWindow: 200000 },
  
  // OpenAI
  'gpt-4o': { inputPerMillion: 5.00, outputPerMillion: 15.00, contextWindow: 128000 },
  'gpt-4o-2024-08-06': { inputPerMillion: 2.50, outputPerMillion: 10.00, contextWindow: 128000 },
  'gpt-4o-mini': { inputPerMillion: 0.150, outputPerMillion: 0.600, contextWindow: 128000 },
  'gpt-4-turbo': { inputPerMillion: 10.00, outputPerMillion: 30.00, contextWindow: 128000 },
  'gpt-3.5-turbo': { inputPerMillion: 0.50, outputPerMillion: 1.50, contextWindow: 16385 },
  
  // Gemini
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00, contextWindow: 1000000 },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30, contextWindow: 1000000 },
  'gemini-2.0-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30, contextWindow: 1000000 }
};

const gpt4oTokenizer = getEncoding('o200k_base');
const defaultTokenizer = getEncoding('cl100k_base');

export function countTokens(text: string, model: string): number {
  try {
    if (model.includes('gpt-4o')) {
      return gpt4oTokenizer.encode(text).length;
    }
    return defaultTokenizer.encode(text).length;
  } catch {
    // Basic approximation: 1 token ~= 4 characters or 0.75 words
    return Math.ceil(text.length / 4);
  }
}

export function estimateRequestTokens(req: NormalizedRequest): number {
  let total = 0;
  for (const msg of req.messages) {
    total += countTokens(msg.content, req.model);
    total += 4; // message packaging overhead
  }
  return total;
}

export interface EstimationResult {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  confidence: number;
  pricing: ModelPricing;
  amplificationReason?: string;
}

export function getPricingForModel(modelName: string): ModelPricing {
  const normalized = Object.keys(PRICING_DIRECTORY).find(key => modelName.toLowerCase().includes(key));
  return PRICING_DIRECTORY[normalized || 'gemini-1.5-flash'];
}

export function calculatePreFlightEstimation(
  req: NormalizedRequest,
  history: Array<{ input: number; output: number }> = []
): EstimationResult {
  const pricing = getPricingForModel(req.model);
  const inputTokens = estimateRequestTokens(req);
  
  // Predict expected output tokens
  let expectedOutput = req.maxTokens;
  if (!expectedOutput) {
    if (history.length > 0) {
      const avgOutput = history.reduce((sum, h) => sum + h.output, 0) / history.length;
      expectedOutput = Math.min(1200, Math.ceil(avgOutput * 1.15));
    } else {
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
  let amplificationReason: string | undefined;

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
