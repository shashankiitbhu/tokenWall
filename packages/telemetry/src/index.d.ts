import { DBManager, GovernanceEvent } from '@tokenwall/core';
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
export interface EmitEventParams {
    eventType: string;
    sessionId: string;
    requestId?: string;
    provider?: string;
    model?: string;
    metadata?: any;
}
export declare class TelemetryLogger {
    private db;
    constructor(db: DBManager);
    emitEvent(params: EmitEventParams): void;
    startSession(sessionId: string, projectId: string | null, budget: number | null): void;
    logRequestStart(sessionId: string, req: NormalizedRequest, requestId: string): void;
    reconcileRequest(requestId: string, finalCost: number, status: 'success' | 'failed' | 'blocked', state: 'reconciled' | 'cancelled' | 'failed'): void;
    getSessionSummary(sessionId: string): SessionSummary;
    getSessions(limit?: number): SessionSummary[];
    reconstructTimeline(sessionId: string): GovernanceEvent[];
    reconstructRequest(requestId: string): GovernanceEvent[];
}
