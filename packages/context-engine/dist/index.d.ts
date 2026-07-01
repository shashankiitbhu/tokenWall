import { NormalizedRequest } from '@tokenwall/providers';
import { TokenWallConfig } from '@tokenwall/core';
export * from './cache-aligner';
export * from './importance';
export * from './query-analyzer';
export interface InefficiencyItem {
    type: 'lockfile' | 'node_modules' | 'binary' | 'minified' | 'logs' | 'duplicate' | 'json' | 'code' | 'volatile_prefix';
    description: string;
    target: string;
    approximateTokens: number;
    potentialSavingsPercent: number;
}
export interface ContextReport {
    inefficiencies: InefficiencyItem[];
    totalWasteTokens: number;
    cleanMessages: NormalizedRequest['messages'];
    cachedContents: {
        id: string;
        content: string;
    }[];
    autoOptimized?: boolean;
}
export declare class JsonCrusher {
    static crush(jsonStr: string): string;
}
export declare class CodeCompressor {
    static compress(code: string, lang?: string, queryKeywords?: string[]): string;
}
export declare class ContextAnalyzer {
    analyze(req: NormalizedRequest, config?: TokenWallConfig): Promise<ContextReport>;
}
export declare class ContextWindowManager {
    static getLimitForModel(model: string): number;
    static fitToBudget(messages: any[], model: string, explicitBudget?: number, config?: TokenWallConfig): {
        messages: any[];
        warnings: string[];
    };
}
