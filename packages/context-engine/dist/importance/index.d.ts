export * from './types';
export * from './detectors';
import { ImportanceContext, ImportancePolicy } from './types';
export declare class ImportanceEngine {
    private detector;
    constructor();
    scoreLine(line: string, ctx: ImportanceContext): number;
    static getThresholdForPolicy(policy?: ImportancePolicy): number;
    pruneLogBlock(text: string, policy?: ImportancePolicy): string;
}
