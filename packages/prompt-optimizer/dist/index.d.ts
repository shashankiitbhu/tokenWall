import { CachedContent } from './code-compressor';
import { ToolPruner } from './tool-pruner';
export interface CoverageMetrics {
    json: {
        magikaDetected: number;
        regexTotalDetected: number;
        successfullyOptimized: number;
        fallbackParseFailure: number;
    };
    code: {
        magikaDetected: number;
        regexTotalDetected: number;
        successfullyOptimized: number;
        fallbackParseFailure: number;
        fallbackOptOutSystemGuard: number;
        fallbackOptOutUserConfig: number;
    };
    sampledFailures: Array<{
        type: 'parse_failure' | 'magika_mismatch';
        reason: string;
        snippet: string;
    }>;
}
export interface OptimizationResult {
    originalText: string;
    optimizedText: string;
    tokensSaved: number;
    savingsPercent: number;
    cachedContents?: CachedContent[];
    coverage?: CoverageMetrics;
}
export interface PromptOptimizerOptions {
    disableCodeCompression?: boolean;
    disableJsonMasking?: boolean;
    optOutReason?: 'system_guard' | 'user_config' | null;
}
export declare class PromptOptimizer {
    optimize(prompt: string, model: string, options?: PromptOptimizerOptions): Promise<OptimizationResult>;
}
export * from './tools';
export { ToolPruner };
