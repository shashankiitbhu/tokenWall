"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetEvaluator = void 0;
class BudgetEvaluator {
    db;
    config;
    constructor(db, config) {
        this.db = db;
        this.config = config;
    }
    evaluate(projectId, sessionId, requestId, estimatedCost, provider = 'unknown', model = 'unknown') {
        const configSettings = this.config.getConfig();
        const warnings = [];
        let dbBudgets = this.db.getBudgets(projectId);
        this.initDefaultBudgets(projectId);
        const reservation = this.db.reserveBudget(projectId, sessionId, requestId, estimatedCost, provider, model);
        return {
            allowed: reservation.allowed,
            blockedReason: reservation.reason,
            warnOnly: false,
            warnings: [],
            currentSessionSpend: this.db.getSessionSpend(sessionId)
        };
    }
    initDefaultBudgets(projectId) {
        const settings = this.config.getConfig();
        // Add Daily Budget
        this.db.createOrUpdateBudget({
            id: projectId ? `${projectId}_daily` : 'global_daily',
            project_id: projectId,
            period: 'daily',
            limit_amount: settings.dailyLimit,
            hard_limit: settings.hardLimitsEnabled ? 1 : 0
        });
        // Add Monthly Budget
        this.db.createOrUpdateBudget({
            id: projectId ? `${projectId}_monthly` : 'global_monthly',
            project_id: projectId,
            period: 'monthly',
            limit_amount: settings.monthlyLimit,
            hard_limit: settings.hardLimitsEnabled ? 1 : 0
        });
        // Add Session Budget
        this.db.createOrUpdateBudget({
            id: projectId ? `${projectId}_session` : 'global_session',
            project_id: projectId,
            period: 'session',
            limit_amount: settings.sessionLimit,
            hard_limit: settings.hardLimitsEnabled ? 1 : 0
        });
    }
}
exports.BudgetEvaluator = BudgetEvaluator;
__exportStar(require("./loopDetector.js"), exports);
