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

  evaluate(projectId: string | null, sessionId: string, estimatedCost: number): BudgetCheckResult {
    const configSettings = this.config.getConfig();
    const warnings: string[] = [];
    let allowed = true;
    let blockedReason: string | undefined;
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
          } else {
            warnOnly = true;
            warnings.push(message);
          }
        }
      } else {
        // Daily / Monthly / Project
        const expectedSpend = current + estimatedCost;
        if (expectedSpend > limit) {
          const message = `${budget.period.toUpperCase()} limit exceeded ($${expectedSpend.toFixed(2)} / $${limit.toFixed(2)}).`;
          if (isHard && configSettings.hardLimitsEnabled) {
            allowed = false;
            blockedReason = message;
          } else {
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
