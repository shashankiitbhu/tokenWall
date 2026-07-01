export interface OptimizationResult {
    originalText: string;
    optimizedText: string;
    tokensSaved: number;
    savingsPercent: number;
}
export declare class PromptOptimizer {
    optimize(prompt: string, model: string): OptimizationResult;
}
export * from './tools';
