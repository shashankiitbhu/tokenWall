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
    evaluate(projectId, sessionId, estimatedCost) {
        const configSettings = this.config.getConfig();
        const warnings = [];
        let allowed = true;
        let blockedReason;
        let warnOnly = false;
        // Get current spent on this session
        const sessionSpend = this.db.getSessionSpend(sessionId);
        const totalSessionExpected = sessionSpend + estimatedCost;
        // Retrieve budgets from SQLite
        let dbBudgets = this.db.getBudgets(projectId);
        // If SQLite budgets are empty, initialize them from config properties
        if (dbBudgets.length === 0) {
            this.initDefaultBudgets(projectId);
            dbBudgets = this.db.getBudgets(projectId);
        }
        // Evaluate budgets (Session, Daily, Monthly)
        for (const budget of dbBudgets) {
            let limit = budget.limit_amount;
            let current = budget.current_spend;
            const isHard = budget.hard_limit === 1;
            // For session period, compare against sessionSpend
            if (budget.period === 'session') {
                if (totalSessionExpected > limit) {
                    const message = `Session spend limit exceeded ($${totalSessionExpected.toFixed(2)} / $${limit.toFixed(2)}).`;
                    if (isHard && configSettings.hardLimitsEnabled) {
                        allowed = false;
                        blockedReason = message;
                    }
                    else {
                        warnOnly = true;
                        warnings.push(message);
                    }
                }
            }
            else {
                // Daily / Monthly / Project
                const expectedSpend = current + estimatedCost;
                if (expectedSpend > limit) {
                    const message = `${budget.period.toUpperCase()} limit exceeded ($${expectedSpend.toFixed(2)} / $${limit.toFixed(2)}).`;
                    if (isHard && configSettings.hardLimitsEnabled) {
                        allowed = false;
                        blockedReason = message;
                    }
                    else {
                        warnOnly = true;
                        warnings.push(message);
                    }
                }
            }
        }
        return {
            allowed,
            blockedReason,
            warnOnly,
            warnings,
            currentSessionSpend: sessionSpend
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
