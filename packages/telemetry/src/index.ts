import { DBManager, Project } from '@tokenwall/core';
import { NormalizedRequest, NormalizedResponse } from '@tokenwall/providers';
import { getPricingForModel } from '@tokenwall/estimators';

export interface SessionSummary {
  sessionId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensSaved: number;
  requestsCount: number;
  blockedCount: number;
}

export class TelemetryLogger {
  private db: DBManager;

  constructor(db: DBManager) {
    this.db = db;
  }

  startSession(sessionId: string, projectId: string | null, budget: number | null) {
    this.db.createSession(sessionId, projectId, budget);
  }

  logRequest(
    sessionId: string,
    req: NormalizedRequest,
    res: NormalizedResponse | null,
    cost: number,
    savedTokens: number,
    status: 'success' | 'failed' | 'blocked'
  ) {
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

  getSessionSummary(sessionId: string): SessionSummary {
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
