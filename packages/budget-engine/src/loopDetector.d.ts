import { DBManager } from '@tokenwall/core';
export interface LoopDetectResult {
    loopDetected: boolean;
    reason?: string;
}
export declare class RunawayLoopDetector {
    private db;
    constructor(db: DBManager);
    detect(sessionId: string, newPrompt: string, newInputTokens: number): LoopDetectResult;
}
