import { DBManager, Budget, ConfigManager } from '@tokenwall/core';

export interface BudgetCheckResult {
  allowed: boolean;
  blockedReason?: string;
  warnOnly: boolean;
  warnings: string[];
  currentSessionSpend: number;
}

export class BudgetEvaluator {
  private db: DBManager;
  private config: ConfigManager;

  constructor(db: DBManager, config: ConfigManager) {
    this.db = db;
    this.config = config;
  }

  evaluate(projectId: string | null, sessionId: string, requestId: string, estimatedCost: number, provider: string = 'unknown', model: string = 'unknown'): BudgetCheckResult {
    const configSettings = this.config.getConfig();
    const warnings: string[] = [];
    
    let dbBudgets = this.db.getBudgets(projectId);
    if (dbBudgets.length === 0) {
      this.initDefaultBudgets(projectId);
    }

    const reservation = this.db.reserveBudget(projectId, sessionId, requestId, estimatedCost, provider, model);

    return {
      allowed: reservation.allowed,
      blockedReason: reservation.reason,
      warnOnly: false,
      warnings: [],
      currentSessionSpend: this.db.getSessionSpend(sessionId)
    };
  }

  private initDefaultBudgets(projectId: string | null) {
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

export * from './loopDetector.js';
