import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
  hard_limit: number; // 1 = true, 0 = false
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

export class DBManager {
  public db: Database.Database;

  constructor(dbPath?: string) {
    console.log("[TokenWall DB] Resolving database path...");
    const finalPath = dbPath || this.getDefaultDBPath();
    console.log(`[TokenWall DB] Path: ${finalPath}`);
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      console.log(`[TokenWall DB] Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
    console.log("[TokenWall DB] Connecting to SQLite...");
    this.db = new Database(finalPath);
    console.log("[TokenWall DB] SQLite connected. Initializing schema...");
    this.initSchema();
    console.log("[TokenWall DB] Schema initialized successfully.");
  }

  getSessionSummary(sessionId: string): { totalInput: number; totalOutput: number; totalCost: number; count: number; blocked: number; saved: number } {
    const res = this.db.prepare(`
      SELECT 
        COALESCE(SUM(input_tokens), 0) as totalInput,
        COALESCE(SUM(output_tokens), 0) as totalOutput,
        COALESCE(SUM(cost), 0) as totalCost,
        COUNT(*) as count,
        COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) as blocked,
        COALESCE(SUM(optimized_tokens_saved), 0) as saved
      FROM requests 
      WHERE session_id = ?
    `).get(sessionId) as any;
    return res || { totalInput: 0, totalOutput: 0, totalCost: 0, count: 0, blocked: 0, saved: 0 };
  }

  private getDefaultDBPath(): string {
    return path.join(os.homedir(), '.tokenwall', 'database.sqlite');
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        period TEXT CHECK(period IN ('daily', 'monthly', 'session', 'project')),
        limit_amount REAL NOT NULL,
        current_spend REAL DEFAULT 0.0,
        hard_limit INTEGER DEFAULT 1,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        session_budget REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        original_model TEXT,
        routing_action TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        optimized_tokens_saved INTEGER DEFAULT 0,
        status TEXT CHECK(status IN ('success', 'failed', 'blocked')),
        state TEXT DEFAULT 'completed' CHECK(state IN ('pending', 'streaming', 'completed', 'failed', 'cancelled', 'reconciled')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        request_id TEXT UNIQUE NOT NULL,
        project_id TEXT,
        session_id TEXT NOT NULL,
        amount REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(request_id) REFERENCES requests(id),
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        request_id TEXT,
        session_id TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS savings_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT,
        saving_type TEXT NOT NULL CHECK(saving_type IN ('block_runaway', 'block_budget', 'switch_model', 'optimize_prompt')),
        amount REAL NOT NULL,
        saved_tokens INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS tool_call_usage (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_length INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(request_id) REFERENCES requests(id)
      );

      CREATE TABLE IF NOT EXISTS cached_contents (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        original_content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(request_id) REFERENCES requests(id)
      );

      CREATE VIEW IF NOT EXISTS workspace_usage AS
      SELECT 
        p.id as project_id, 
        p.name as project_name, 
        p.path as project_path,
        COALESCE(SUM(r.cost), 0) as total_spend
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      LEFT JOIN requests r ON r.session_id = s.id
      GROUP BY p.id;

      CREATE VIEW IF NOT EXISTS provider_usage AS
      SELECT 
        provider, 
        COALESCE(SUM(cost), 0) as total_spend, 
        COUNT(*) as request_count 
      FROM requests 
      GROUP BY provider;

      CREATE VIEW IF NOT EXISTS model_usage AS
      SELECT 
        model, 
        COALESCE(SUM(cost), 0) as total_spend, 
        COUNT(*) as request_count 
      FROM requests 
      GROUP BY model;

      CREATE VIEW IF NOT EXISTS spend_summary AS
      SELECT 
        COALESCE(SUM(cost), 0) as total_spend, 
        COALESCE(SUM(optimized_tokens_saved), 0) as total_tokens_saved 
      FROM requests;
    `);
    this.runMigrations();
  }

  private runMigrations() {
    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN state TEXT DEFAULT 'completed' CHECK(state IN ('pending', 'streaming', 'completed', 'failed', 'cancelled', 'reconciled'));");
    } catch (e) {
      // Column might already exist
    }
    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN original_model TEXT;");
    } catch (e) {
    }
    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN routing_action TEXT;");
    } catch (e) {
    }
    try {
      // Ensure index on events table for rapid queries
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);");
    } catch (e) {
    }
  }

  // Projects
  getOrCreateProject(name: string, dirPath: string): Project {
    const existing = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(dirPath) as Project | undefined;
    if (existing) return existing;

    const id = Math.random().toString(36).substring(2, 11);
    this.db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, name, dirPath);
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project;
  }

  // Budgets
  getBudgets(projectId: string | null): Budget[] {
    if (projectId) {
      return this.db.prepare('SELECT * FROM budgets WHERE project_id = ? OR project_id IS NULL').all(projectId) as Budget[];
    }
    return this.db.prepare('SELECT * FROM budgets WHERE project_id IS NULL').all() as Budget[];
  }

  createOrUpdateBudget(budget: Omit<Budget, 'current_spend'>) {
    this.db.prepare(`
      INSERT INTO budgets (id, project_id, period, limit_amount, hard_limit)
      VALUES (@id, @project_id, @period, @limit_amount, @hard_limit)
      ON CONFLICT(id) DO UPDATE SET
        limit_amount = excluded.limit_amount,
        hard_limit = excluded.hard_limit
    `).run(budget);
  }

  incrementBudgetSpend(projectId: string | null, amount: number) {
    if (projectId) {
      this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id = ? OR project_id IS NULL').run(amount, projectId);
    } else {
      this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id IS NULL').run(amount);
    }
  }

  resetBudgets(period: 'daily' | 'monthly') {
    this.db.prepare('UPDATE budgets SET current_spend = 0.0 WHERE period = ?').run(period);
  }

  // Sessions
  createSession(id: string, projectId: string | null, sessionBudget: number | null): Session {
    this.db.prepare('INSERT INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(id, projectId, sessionBudget);
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
  }

  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getSessions(limit: number = 50): Session[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit) as Session[];
  }

  getSessionSpend(sessionId: string): number {
    const res = this.db.prepare('SELECT SUM(cost) as total FROM requests WHERE session_id = ?').get(sessionId) as { total: number | null } | undefined;
    return res?.total || 0;
  }

  // Requests
  logRequest(log: Omit<RequestLog, 'created_at'>) {
    this.db.prepare(`
      INSERT INTO requests (id, session_id, provider, model, original_model, routing_action, input_tokens, output_tokens, cost, optimized_tokens_saved, status, state)
      VALUES (@id, @session_id, @provider, @model, @original_model, @routing_action, @input_tokens, @output_tokens, @cost, @optimized_tokens_saved, @status, @state)
    `).run(log);
  }

  logEvent(event: Omit<GovernanceEvent, 'created_at'>) {
    this.db.prepare(`
      INSERT INTO events (id, event_type, request_id, session_id, provider, model, metadata)
      VALUES (@id, @event_type, @request_id, @session_id, @provider, @model, @metadata)
    `).run(event);
  }

  getEventsForSession(sessionId: string): GovernanceEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as GovernanceEvent[];
  }

  getEventsForRequest(requestId: string): GovernanceEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE request_id = ? ORDER BY created_at ASC').all(requestId) as GovernanceEvent[];
  }

  updateRequestTokens(requestId: string, inputTokens: number, outputTokens: number, savedTokens: number = 0) {
    this.db.prepare('UPDATE requests SET input_tokens = ?, output_tokens = ?, optimized_tokens_saved = ? WHERE id = ?').run(inputTokens, outputTokens, savedTokens, requestId);
  }

  updateRequestRouting(requestId: string, originalModel: string, routingAction: string) {
    this.db.prepare('UPDATE requests SET original_model = ?, routing_action = ? WHERE id = ?').run(originalModel, routingAction, requestId);
  }

  reserveBudget(projectId: string | null, sessionId: string, requestId: string, estimatedCost: number, provider: string = 'unknown', model: string = 'unknown', originalModel: string | null = null, routingAction: string | null = null): { allowed: boolean; reason?: string } {
    const txn = this.db.transaction(() => {
      let budgets = [];
      if (projectId) {
        budgets = this.db.prepare('SELECT * FROM budgets WHERE project_id = ? OR project_id IS NULL').all(projectId) as Budget[];
      } else {
        budgets = this.db.prepare('SELECT * FROM budgets WHERE project_id IS NULL').all() as Budget[];
      }

      for (const budget of budgets) {
        let pendingStmt;
        if (budget.project_id) {
           pendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE project_id = ?').get(budget.project_id) as { pending: number | null };
        } else {
           pendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE project_id IS NULL').get() as { pending: number | null };
        }
        
        const pendingAmount = pendingStmt.pending || 0;
        const totalProjected = budget.current_spend + pendingAmount + estimatedCost;

        if (budget.hard_limit && totalProjected > budget.limit_amount) {
           return { allowed: false, reason: `Budget Exceeded: Project/Global (${budget.period}) limit of $${budget.limit_amount} reached. Current: $${budget.current_spend}, Pending: $${pendingAmount}, Requested: $${estimatedCost}` };
        }
      }

      const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
      if (session && session.session_budget) {
         const sessionSpendStmt = this.db.prepare("SELECT SUM(cost) as spend FROM requests WHERE session_id = ? AND state = 'reconciled'").get(sessionId) as { spend: number | null };
         const sessionSpend = sessionSpendStmt.spend || 0;
         const sessionPendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE session_id = ?').get(sessionId) as { pending: number | null };
         const sessionPending = sessionPendingStmt.pending || 0;
         const totalSessionProjected = sessionSpend + sessionPending + estimatedCost;

         if (totalSessionProjected > session.session_budget) {
            return { allowed: false, reason: `Budget Exceeded: Session limit of $${session.session_budget} reached. Current: $${sessionSpend}, Pending: $${sessionPending}, Requested: $${estimatedCost}` };
         }
      }

      this.db.prepare(`
        INSERT INTO requests (id, session_id, provider, model, original_model, routing_action, input_tokens, output_tokens, cost, status, state)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'success', 'streaming')
      `).run(requestId, sessionId, provider, model, originalModel, routingAction);

      const resId = Math.random().toString(36).substring(2, 11);
      this.db.prepare('INSERT INTO reservations (id, request_id, project_id, session_id, amount) VALUES (?, ?, ?, ?, ?)').run(resId, requestId, projectId, sessionId, estimatedCost);

      return { allowed: true };
    });

    return txn();
  }

  reconcileBudget(requestId: string, finalCost: number, finalStatus: 'success' | 'failed' | 'blocked', finalState: 'reconciled' | 'cancelled' | 'failed') {
    const txn = this.db.transaction(() => {
      const res = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId) as any;
      
      if (res) {
         if (res.project_id) {
           this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id = ? OR project_id IS NULL').run(finalCost, res.project_id);
         } else {
           this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id IS NULL').run(finalCost);
         }
         this.db.prepare('DELETE FROM reservations WHERE id = ?').run(res.id);
      }

      this.db.prepare('UPDATE requests SET cost = ?, status = ?, state = ? WHERE id = ?').run(finalCost, finalStatus, finalState, requestId);
    });
    txn();
  }

  reconcileStaleReservations() {
     const txn = this.db.transaction(() => {
        const stales = this.db.prepare('SELECT * FROM reservations').all() as any[];
        for (const stale of stales) {
           this.db.prepare('DELETE FROM reservations WHERE id = ?').run(stale.id);
           this.db.prepare("UPDATE requests SET status = 'failed', state = 'failed' WHERE id = ?").run(stale.request_id);
        }
     });
     txn();
  }

  // Savings and tool calls helpers
  logSavingsEvent(event: { id: string; sessionId: string; requestId: string | null; type: string; amount: number; tokens: number }) {
    this.db.prepare(`
      INSERT INTO savings_events (id, session_id, request_id, saving_type, amount, saved_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.sessionId, event.requestId, event.type, event.amount, event.tokens);
  }

  logToolCall(id: string, requestId: string, toolName: string, inputLength: number = 0) {
    this.db.prepare(`
      INSERT INTO tool_call_usage (id, request_id, tool_name, input_length)
      VALUES (?, ?, ?, ?)
    `).run(id, requestId, toolName, inputLength);
  }

  getWorkspaceUsage(): any[] {
    return this.db.prepare('SELECT * FROM workspace_usage').all();
  }

  getProviderUsage(): any[] {
    return this.db.prepare('SELECT * FROM provider_usage').all();
  }

  getModelUsage(): any[] {
    return this.db.prepare('SELECT * FROM model_usage').all();
  }

  getSavingsSummary(sessionId?: string): { preventedSpend: number; optimizedSavings: number; savedTokens: number } {
    let preventedStmt;
    let optimizedStmt;
    
    if (sessionId) {
      preventedStmt = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as amt FROM savings_events WHERE session_id = ? AND saving_type IN ('block_runaway', 'block_budget')").get(sessionId) as { amt: number };
      optimizedStmt = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as amt, COALESCE(SUM(saved_tokens), 0) as tokens FROM savings_events WHERE session_id = ? AND saving_type IN ('optimize_prompt', 'switch_model')").get(sessionId) as { amt: number; tokens: number };
    } else {
      preventedStmt = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as amt FROM savings_events WHERE saving_type IN ('block_runaway', 'block_budget')").get() as { amt: number };
      optimizedStmt = this.db.prepare("SELECT COALESCE(SUM(amount), 0) as amt, COALESCE(SUM(saved_tokens), 0) as tokens FROM savings_events WHERE saving_type IN ('optimize_prompt', 'switch_model')").get() as { amt: number; tokens: number };
    }
    
    return {
      preventedSpend: preventedStmt?.amt || 0,
      optimizedSavings: optimizedStmt?.amt || 0,
      savedTokens: optimizedStmt?.tokens || 0
    };
  }

  saveCachedContent(id: string, requestId: string, content: string) {
    this.db.prepare(`
      INSERT INTO cached_contents (id, request_id, original_content)
      VALUES (?, ?, ?)
    `).run(id, requestId, content);
  }

  getCachedContent(id: string): string | undefined {
    const res = this.db.prepare('SELECT original_content FROM cached_contents WHERE id = ?').get(id) as { original_content: string } | undefined;
    return res?.original_content;
  }

  getCachedContentWithSessionCheck(id: string, requesterSessionId: string): string | undefined {
    const res = this.db.prepare(`
      SELECT c.original_content 
      FROM cached_contents c
      JOIN requests r ON c.request_id = r.id
      WHERE c.id = ? AND r.session_id = ?
    `).get(id, requesterSessionId) as { original_content: string } | undefined;
    return res?.original_content;
  }

  close() {
    this.db.close();
  }
}
