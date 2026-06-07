"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DBManager = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
class DBManager {
    db;
    constructor(dbPath) {
        const finalPath = dbPath || this.getDefaultDBPath();
        const dir = path_1.default.dirname(finalPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        this.db = new better_sqlite3_1.default(finalPath);
        this.initSchema();
    }
    getSessionSummary(sessionId) {
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
    `).get(sessionId);
        return res || { totalInput: 0, totalOutput: 0, totalCost: 0, count: 0, blocked: 0, saved: 0 };
    }
    getDefaultDBPath() {
        return path_1.default.join(os_1.default.homedir(), '.tokenwall', 'database.sqlite');
    }
    initSchema() {
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
    `);
        this.runMigrations();
    }
    runMigrations() {
        try {
            this.db.exec("ALTER TABLE requests ADD COLUMN state TEXT DEFAULT 'completed' CHECK(state IN ('pending', 'streaming', 'completed', 'failed', 'cancelled', 'reconciled'));");
        }
        catch (e) {
            // Column might already exist
        }
        try {
            this.db.exec("ALTER TABLE requests ADD COLUMN original_model TEXT;");
        }
        catch (e) {
        }
        try {
            this.db.exec("ALTER TABLE requests ADD COLUMN routing_action TEXT;");
        }
        catch (e) {
        }
    }
    // Projects
    getOrCreateProject(name, dirPath) {
        const existing = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(dirPath);
        if (existing)
            return existing;
        const id = Math.random().toString(36).substring(2, 11);
        this.db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, name, dirPath);
        return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    }
    // Budgets
    getBudgets(projectId) {
        if (projectId) {
            return this.db.prepare('SELECT * FROM budgets WHERE project_id = ? OR project_id IS NULL').all(projectId);
        }
        return this.db.prepare('SELECT * FROM budgets WHERE project_id IS NULL').all();
    }
    createOrUpdateBudget(budget) {
        this.db.prepare(`
      INSERT INTO budgets (id, project_id, period, limit_amount, hard_limit)
      VALUES (@id, @project_id, @period, @limit_amount, @hard_limit)
      ON CONFLICT(id) DO UPDATE SET
        limit_amount = excluded.limit_amount,
        hard_limit = excluded.hard_limit
    `).run(budget);
    }
    incrementBudgetSpend(projectId, amount) {
        if (projectId) {
            this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id = ? OR project_id IS NULL').run(amount, projectId);
        }
        else {
            this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id IS NULL').run(amount);
        }
    }
    resetBudgets(period) {
        this.db.prepare('UPDATE budgets SET current_spend = 0.0 WHERE period = ?').run(period);
    }
    // Sessions
    createSession(id, projectId, sessionBudget) {
        this.db.prepare('INSERT INTO sessions (id, project_id, session_budget) VALUES (?, ?, ?)').run(id, projectId, sessionBudget);
        return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    }
    getSession(id) {
        return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    }
    getSessionSpend(sessionId) {
        const res = this.db.prepare('SELECT SUM(cost) as total FROM requests WHERE session_id = ?').get(sessionId);
        return res?.total || 0;
    }
    // Requests
    logRequest(log) {
        this.db.prepare(`
      INSERT INTO requests (id, session_id, provider, model, original_model, routing_action, input_tokens, output_tokens, cost, optimized_tokens_saved, status, state)
      VALUES (@id, @session_id, @provider, @model, @original_model, @routing_action, @input_tokens, @output_tokens, @cost, @optimized_tokens_saved, @status, @state)
    `).run(log);
    }
    updateRequestTokens(requestId, inputTokens, outputTokens) {
        this.db.prepare('UPDATE requests SET input_tokens = ?, output_tokens = ? WHERE id = ?').run(inputTokens, outputTokens, requestId);
    }
    updateRequestRouting(requestId, originalModel, routingAction) {
        this.db.prepare('UPDATE requests SET original_model = ?, routing_action = ? WHERE id = ?').run(originalModel, routingAction, requestId);
    }
    reserveBudget(projectId, sessionId, requestId, estimatedCost, provider = 'unknown', model = 'unknown', originalModel = null, routingAction = null) {
        const txn = this.db.transaction(() => {
            let budgets = [];
            if (projectId) {
                budgets = this.db.prepare('SELECT * FROM budgets WHERE project_id = ? OR project_id IS NULL').all(projectId);
            }
            else {
                budgets = this.db.prepare('SELECT * FROM budgets WHERE project_id IS NULL').all();
            }
            for (const budget of budgets) {
                let pendingStmt;
                if (budget.project_id) {
                    pendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE project_id = ?').get(budget.project_id);
                }
                else {
                    pendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE project_id IS NULL').get();
                }
                const pendingAmount = pendingStmt.pending || 0;
                const totalProjected = budget.current_spend + pendingAmount + estimatedCost;
                if (budget.hard_limit && totalProjected > budget.limit_amount) {
                    return { allowed: false, reason: `Budget Exceeded: Project/Global (${budget.period}) limit of $${budget.limit_amount} reached. Current: $${budget.current_spend}, Pending: $${pendingAmount}, Requested: $${estimatedCost}` };
                }
            }
            const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
            if (session && session.session_budget) {
                const sessionSpendStmt = this.db.prepare("SELECT SUM(cost) as spend FROM requests WHERE session_id = ? AND state = 'reconciled'").get(sessionId);
                const sessionSpend = sessionSpendStmt.spend || 0;
                const sessionPendingStmt = this.db.prepare('SELECT SUM(amount) as pending FROM reservations WHERE session_id = ?').get(sessionId);
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
    reconcileBudget(requestId, finalCost, finalStatus, finalState) {
        const txn = this.db.transaction(() => {
            const res = this.db.prepare('SELECT * FROM reservations WHERE request_id = ?').get(requestId);
            if (res) {
                if (res.project_id) {
                    this.db.prepare('UPDATE budgets SET current_spend = current_spend + ? WHERE project_id = ? OR project_id IS NULL').run(finalCost, res.project_id);
                }
                else {
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
            const stales = this.db.prepare('SELECT * FROM reservations').all();
            for (const stale of stales) {
                this.db.prepare('DELETE FROM reservations WHERE id = ?').run(stale.id);
                this.db.prepare("UPDATE requests SET status = 'failed', state = 'failed' WHERE id = ?").run(stale.request_id);
            }
        });
        txn();
    }
    close() {
        this.db.close();
    }
}
exports.DBManager = DBManager;
