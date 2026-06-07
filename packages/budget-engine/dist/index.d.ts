import { DBManager, ConfigManager } from '@tokenwall/core';
export interface BudgetCheckResult {
    allowed: boolean;
    blockedReason?: string;
    warnOnly: boolean;
    warnings: string[];
    currentSessionSpend: number;
}
export declare class BudgetEvaluator {
    private db;
    private config;
    constructor(db: DBManager, config: ConfigManager);
    evaluate(projectId: string | null, sessionId: string, estimatedCost: number): BudgetCheckResult;
    private initDefaultBudgets;
}
export * from './loopDetector.js';
