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
  status: 'success' | 'failed' | 'blocked';
  created_at: string;
}

export class DBManager {
  public db: Database.Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || this.getDefaultDBPath();
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(finalPath);
    this.initSchema();
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
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        optimized_tokens_saved INTEGER DEFAULT 0,
        status TEXT CHECK(status IN ('success', 'failed', 'blocked')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);
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

  getSessionSpend(sessionId: string): number {
    const res = this.db.prepare('SELECT SUM(cost) as total FROM requests WHERE session_id = ?').get(sessionId) as { total: number | null } | undefined;
    return res?.total || 0;
  }

  // Requests
  logRequest(log: Omit<RequestLog, 'created_at'>) {
    this.db.prepare(`
      INSERT INTO requests (id, session_id, provider, model, input_tokens, output_tokens, cost, optimized_tokens_saved, status)
      VALUES (@id, @session_id, @provider, @model, @input_tokens, @output_tokens, @cost, @optimized_tokens_saved, @status)
    `).run(log);
  }

  close() {
    this.db.close();
  }
}
