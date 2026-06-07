"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryLogger = void 0;
class TelemetryLogger {
    db;
    constructor(db) {
        this.db = db;
    }
    startSession(sessionId, projectId, budget) {
        this.db.createSession(sessionId, projectId, budget);
    }
    logRequestStart(sessionId, req, requestId) {
        // Basic log initialized by DB reserveBudget, so we just ensure DB sync if needed
        // Actually db.reserveBudget already creates the request and reservation!
        // We don't need to insert here, db.reserveBudget does it.
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
}
exports.TelemetryLogger = TelemetryLogger;
