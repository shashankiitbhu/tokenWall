export * from './attribution';
import { NormalizedRequest } from '@tokenwall/providers';
export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
    contextWindow: number;
}
export declare const PRICING_DIRECTORY: Record<string, ModelPricing>;
export declare function countTokens(text: string, model: string): number;
export declare function estimateRequestTokens(req: NormalizedRequest): number;
export interface EstimationResult {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCost: number;
    confidence: number;
    pricing: ModelPricing;
    amplificationReason?: string;
}
export declare function getPricingForModel(modelName: string): ModelPricing;
export declare function calculatePreFlightEstimation(req: NormalizedRequest, history?: Array<{
    input: number;
    output: number;
}>): EstimationResult;
