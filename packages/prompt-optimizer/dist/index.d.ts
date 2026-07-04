import { ToolPruner } from './tool-pruner';
export interface OptimizationResult {
    originalText: string;
    optimizedText: string;
    tokensSaved: number;
    savingsPercent: number;
}
export interface PromptOptimizerOptions {
    disableCodeCompression?: boolean;
}
export declare class PromptOptimizer {
    optimize(prompt: string, model: string, options?: PromptOptimizerOptions): OptimizationResult;
}
export * from './tools';
export { ToolPruner };
