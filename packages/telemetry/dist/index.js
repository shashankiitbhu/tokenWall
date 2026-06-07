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
    logRequest(sessionId, req, res, cost, savedTokens, status) {
        const id = Math.random().toString(36).substring(2, 11);
        const inputTokens = res?.usage?.inputTokens || 0;
        const outputTokens = res?.usage?.outputTokens || 0;
        // Log the request to local SQLite
        this.db.logRequest({
            id,
            session_id: sessionId,
            provider: req.provider,
            model: req.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost,
            optimized_tokens_saved: savedTokens,
            status
        });
        // Retrieve the active session to find the associated project ID
        const session = this.db.getSession(sessionId);
        const projectId = session ? session.project_id : null;
        // Increment budget consumption in the database
        this.db.incrementBudgetSpend(projectId, cost);
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
