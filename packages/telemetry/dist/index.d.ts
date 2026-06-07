import { DBManager } from '@tokenwall/core';
import { NormalizedRequest } from '@tokenwall/providers';
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
    logRequestStart(sessionId: string, req: NormalizedRequest, requestId: string): void;
    reconcileRequest(requestId: string, finalCost: number, status: 'success' | 'failed' | 'blocked', state: 'reconciled' | 'cancelled' | 'failed'): void;
    getSessionSummary(sessionId: string): SessionSummary;
}
