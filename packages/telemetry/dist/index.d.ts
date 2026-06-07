import { DBManager } from '@tokenwall/core';
import { NormalizedRequest, NormalizedResponse } from '@tokenwall/providers';
export interface SessionSummary {
    sessionId: string;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    tokensSaved: number;
    requestsCount: number;
    blockedCount: number;
}
export declare class TelemetryLogger {
    private db;
    constructor(db: DBManager);
    startSession(sessionId: string, projectId: string | null, budget: number | null): void;
    logRequest(sessionId: string, req: NormalizedRequest, res: NormalizedResponse | null, cost: number, savedTokens: number, status: 'success' | 'failed' | 'blocked'): void;
    getSessionSummary(sessionId: string): SessionSummary;
}
