import { NormalizedRequest } from '@tokenwall/providers';
export type TaskComplexity = 'low' | 'medium' | 'high';
export interface RoutingAlternative {
    model: string;
    estimatedCost: number;
    qualityLevel: 'High' | 'Medium-High' | 'Medium';
    savingsPercentage: number;
}
export interface RouteRecommendation {
    complexity: TaskComplexity;
    shouldRoute: boolean;
    originalModel: string;
    originalEstimatedCost: number;
    alternatives: RoutingAlternative[];
    explanation: string;
}
export declare class ModelRouter {
    classifyComplexity(req: NormalizedRequest): TaskComplexity;
    private calcCost;
    generateRoutingOptions(req: NormalizedRequest, inputTokens: number, expectedOutputTokens: number): RouteRecommendation;
}
