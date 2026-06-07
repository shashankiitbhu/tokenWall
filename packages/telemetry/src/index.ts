import { DBManager, Project, GovernanceEvent } from '@tokenwall/core';
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

export interface EmitEventParams {
  eventType: string;
  sessionId: string;
  requestId?: string;
  provider?: string;
  model?: string;
  metadata?: any;
}

export class TelemetryLogger {
  private db: DBManager;

  constructor(db: DBManager) {
    this.db = db;
  }

  emitEvent(params: EmitEventParams) {
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

  startSession(sessionId: string, projectId: string | null, budget: number | null) {
    this.db.createSession(sessionId, projectId, budget);
  }

  logRequestStart(
    sessionId: string,
    req: NormalizedRequest,
    requestId: string
  ) {
    // legacy logRequestStart, kept for compatibility if needed. The DB handles reservation internally.
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

  getSessions(limit: number = 50): SessionSummary[] {
    const sessions = this.db.getSessions(limit);
    return sessions.map(s => this.getSessionSummary(s.id));
  }

  reconstructTimeline(sessionId: string): GovernanceEvent[] {
    return this.db.getEventsForSession(sessionId);
  }

  reconstructRequest(requestId: string): GovernanceEvent[] {
    return this.db.getEventsForRequest(requestId);
  }
}
