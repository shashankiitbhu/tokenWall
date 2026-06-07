"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryLogger = void 0;
class TelemetryLogger {
    db;
    constructor(db) {
        this.db = db;
    }
    emitEvent(params) {
        const eventId = Math.random().toString(36).substring(2, 15);
        this.db.logEvent({
            id: eventId,
            event_type: params.eventType,
            request_id: params.requestId || null,
            session_id: params.sessionId,
            provider: params.provider || null,
            model: params.model || null,
            metadata: params.metadata ? JSON.stringify(params.metadata) : '{}'
        });
    }
    startSession(sessionId, projectId, budget) {
        this.db.createSession(sessionId, projectId, budget);
    }
    logRequestStart(sessionId, req, requestId) {
        // legacy logRequestStart, kept for compatibility if needed. The DB handles reservation internally.
    }
    reconcileRequest(requestId, finalCost, status, state) {
        this.db.reconcileBudget(requestId, finalCost, status, state);
    }
    getSessionSummary(sessionId) {
        const session = this.db.getSession(sessionId);
        if (!session) {
            return {
                sessionId,
                totalCost: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                tokensSaved: 0,
                requestsCount: 0,
                blockedCount: 0
            };
        }
        const summary = this.db.getSessionSummary(sessionId);
        return {
            sessionId,
            totalCost: summary.totalCost,
            totalInputTokens: summary.totalInput,
            totalOutputTokens: summary.totalOutput,
            tokensSaved: summary.saved,
            requestsCount: summary.count,
            blockedCount: summary.blocked
        };
    }
    getSessions(limit = 50) {
        const sessions = this.db.getSessions(limit);
        return sessions.map(s => this.getSessionSummary(s.id));
    }
    reconstructTimeline(sessionId) {
        return this.db.getEventsForSession(sessionId);
    }
    reconstructRequest(requestId) {
        return this.db.getEventsForRequest(requestId);
    }
}
exports.TelemetryLogger = TelemetryLogger;
