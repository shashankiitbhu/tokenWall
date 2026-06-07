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

  logRequestStart(
    sessionId: string,
    req: NormalizedRequest,
    requestId: string
  ) {
    // Basic log initialized by DB reserveBudget, so we just ensure DB sync if needed
    // Actually db.reserveBudget already creates the request and reservation!
    // We don't need to insert here, db.reserveBudget does it.
  }

  reconcileRequest(
    requestId: string,
    finalCost: number,
    status: 'success' | 'failed' | 'blocked',
    state: 'reconciled' | 'cancelled' | 'failed'
  ) {
    this.db.reconcileBudget(requestId, finalCost, status, state);
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
