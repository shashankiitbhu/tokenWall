import { NormalizedRequest } from '@tokenwall/providers';
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
export declare class ModelRouter {
    classifyComplexity(req: NormalizedRequest): TaskComplexity;
    recommendRoute(req: NormalizedRequest, inputTokens: number, expectedOutputTokens: number): RouteRecommendation;
}
