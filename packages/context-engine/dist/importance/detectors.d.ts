import { ImportanceDetector, ImportanceSignal, ImportanceContext } from './types';
export declare class KeywordDetector implements ImportanceDetector {
    private highSignalRegex;
    private lowSignalRegex;
    score(line: string, ctx: ImportanceContext): ImportanceSignal | null;
}
export declare class StructureDetector implements ImportanceDetector {
    score(line: string, ctx: ImportanceContext): ImportanceSignal | null;
}
export declare class TieredDetector implements ImportanceDetector {
    private detectors;
    constructor(detectors: ImportanceDetector[]);
    score(line: string, ctx: ImportanceContext): ImportanceSignal | null;
}
