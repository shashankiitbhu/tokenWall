import { NormalizedRequest } from '@tokenwall/providers';
export interface InefficiencyItem {
    type: 'lockfile' | 'node_modules' | 'binary' | 'minified' | 'logs' | 'duplicate';
    description: string;
    target: string;
    approximateTokens: number;
    potentialSavingsPercent: number;
}
export interface ContextReport {
    inefficiencies: InefficiencyItem[];
    totalWasteTokens: number;
    cleanMessages: NormalizedRequest['messages'];
}
export declare class ContextAnalyzer {
    analyze(req: NormalizedRequest): ContextReport;
}
