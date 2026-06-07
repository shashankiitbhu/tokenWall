import Database from 'better-sqlite3';
export interface Project {
    id: string;
    name: string;
    path: string;
    created_at: string;
}
export interface Budget {
    id: string;
    project_id: string | null;
    period: 'daily' | 'monthly' | 'session' | 'project';
    limit_amount: number;
    current_spend: number;
    hard_limit: number;
}
export interface Session {
    id: string;
    project_id: string | null;
    session_budget: number | null;
    created_at: string;
}
export interface RequestLog {
    id: string;
    session_id: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    optimized_tokens_saved: number;
    original_model?: string | null;
    routing_action?: string | null;
    status: 'success' | 'failed' | 'blocked';
    state: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'reconciled';
    created_at: string;
}
export interface GovernanceEvent {
    id: string;
    event_type: string;
    request_id: string | null;
    session_id: string;
    provider: string | null;
    model: string | null;
    metadata: string;
    created_at: string;
}
export declare class DBManager {
    db: Database.Database;
    constructor(dbPath?: string);
    getSessionSummary(sessionId: string): {
        totalInput: number;
        totalOutput: number;
        totalCost: number;
        count: number;
        blocked: number;
        saved: number;
    };
    private getDefaultDBPath;
    private initSchema;
    private runMigrations;
    getOrCreateProject(name: string, dirPath: string): Project;
    getBudgets(projectId: string | null): Budget[];
    createOrUpdateBudget(budget: Omit<Budget, 'current_spend'>): void;
    incrementBudgetSpend(projectId: string | null, amount: number): void;
    resetBudgets(period: 'daily' | 'monthly'): void;
    createSession(id: string, projectId: string | null, sessionBudget: number | null): Session;
    getSession(id: string): Session | undefined;
    getSessions(limit?: number): Session[];
    getSessionSpend(sessionId: string): number;
    logRequest(log: Omit<RequestLog, 'created_at'>): void;
    logEvent(event: Omit<GovernanceEvent, 'created_at'>): void;
    getEventsForSession(sessionId: string): GovernanceEvent[];
    getEventsForRequest(requestId: string): GovernanceEvent[];
    updateRequestTokens(requestId: string, inputTokens: number, outputTokens: number): void;
    updateRequestRouting(requestId: string, originalModel: string, routingAction: string): void;
    reserveBudget(projectId: string | null, sessionId: string, requestId: string, estimatedCost: number, provider?: string, model?: string, originalModel?: string | null, routingAction?: string | null): {
        allowed: boolean;
        reason?: string;
    };
    reconcileBudget(requestId: string, finalCost: number, finalStatus: 'success' | 'failed' | 'blocked', finalState: 'reconciled' | 'cancelled' | 'failed'): void;
    reconcileStaleReservations(): void;
    logSavingsEvent(event: {
        id: string;
        sessionId: string;
        requestId: string | null;
        type: string;
        amount: number;
        tokens: number;
    }): void;
    logToolCall(id: string, requestId: string, toolName: string, inputLength?: number): void;
    getWorkspaceUsage(): any[];
    getProviderUsage(): any[];
    getModelUsage(): any[];
    getSavingsSummary(sessionId?: string): {
        preventedSpend: number;
        optimizedSavings: number;
        savedTokens: number;
    };
    close(): void;
}
