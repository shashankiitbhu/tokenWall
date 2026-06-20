import { NormalizedRequest } from '@tokenwall/providers';
import { TokenWallConfig } from '@tokenwall/core';
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
}
export declare class JsonCrusher {
    static crush(jsonStr: string): string;
}
export declare class CodeCompressor {
    static compress(code: string): string;
}
export declare class CacheAligner {
    static normalizeWhitespace(text: string): string;
    static detectVolatileTokens(text: string): {
        type: string;
        value: string;
    }[];
}
export declare class ContextAnalyzer {
    analyze(req: NormalizedRequest, config?: TokenWallConfig): ContextReport;
}
