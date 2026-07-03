import { useEffect, useState } from 'react';
import './index.css';

interface SessionSummary {
  sessionId: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensSaved: number;
  requestsCount: number;
  blockedCount: number;
}

interface GovernanceEvent {
  id: string;
  event_type: string;
  request_id: string | null;
  session_id: string;
  provider: string | null;
  model: string | null;
  metadata: string;
  created_at: string;
}

interface WorkspaceUsage {
  project_id: string;
  project_name: string;
  project_path: string;
  total_spend: number;
}

interface ProviderUsage {
  provider: string;
  total_spend: number;
  request_count: number;
}

interface ModelUsage {
  model: string;
  total_spend: number;
  request_count: number;
}

interface SummaryData {
  dailySpend: number;
  dailyLimit: number;
  preventedSpend: number;
  optimizedSavings: number;
  savedTokens: number;
  workspaces: WorkspaceUsage[];
  providers: ProviderUsage[];
  models: ModelUsage[];
}

interface Budget {
  id: string;
  project_id: string | null;
  period: 'daily' | 'monthly' | 'session' | 'project';
  limit_amount: number;
  current_spend: number;
  hard_limit: number;
}

const API_BASE = 'http://127.0.0.1:1984/api/admin';

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [events, setEvents] = useState<GovernanceEvent[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [isConnected, setIsConnected] = useState<boolean>(true);

  // Poll for telemetry and configuration data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sessionsRes, summaryRes, budgetsRes] = await Promise.all([
          fetch(`${API_BASE}/sessions`),
          fetch(`${API_BASE}/summary`),
          fetch(`${API_BASE}/budgets`)
        ]);

        if (sessionsRes.ok && summaryRes.ok && budgetsRes.ok) {
          const sessionsData = await sessionsRes.json();
          const summaryData = await summaryRes.json();
          const budgetsData = await budgetsRes.json();

          setSessions(sessionsData);
          setSummary(summaryData);
          setBudgets(budgetsData);
          setIsConnected(true);

          // Auto-select the first session if nothing is selected
          if (!selectedSession && sessionsData.length > 0) {
            setSelectedSession(sessionsData[0].sessionId);
          }
        } else {
          setIsConnected(false);
        }
      } catch (err) {
        setIsConnected(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 4000);
    return () => clearInterval(interval);
  }, [selectedSession]);

  // Fetch events when the selected session changes
  useEffect(() => {
    if (selectedSession) {
      fetch(`${API_BASE}/events/${selectedSession}`)
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Failed to fetch events');
        })
        .then(data => setEvents(data))
        .catch(console.error);
    }
  }, [selectedSession]);

  const formatMetadata = (metaStr: string) => {
    try {
      const obj = JSON.parse(metaStr);
      return JSON.stringify(obj, null, 2);
    } catch (e) {
      return metaStr;
    }
  };

  const getEventBadgeClass = (type: string) => {
    switch (type) {
      case 'request_received':
        return 'badge';
      case 'budget_limit_exceeded':
        return 'badge error-highlight';
      case 'runaway_loop_detected':
        return 'badge warning-highlight';
      case 'approval_granted':
      case 'approval_requested':
        return 'badge accent-highlight';
      case 'request_reconciled':
        return 'badge';
      default:
        return 'badge';
    }
  };

  const dailyBudget = budgets.find(b => b.period === 'daily');
  const monthlyBudget = budgets.find(b => b.period === 'monthly');

  const dailyPercentage = dailyBudget && dailyBudget.limit_amount > 0
    ? Math.min(100, (dailyBudget.current_spend / dailyBudget.limit_amount) * 100)
    : 0;

  const monthlyPercentage = monthlyBudget && monthlyBudget.limit_amount > 0
    ? Math.min(100, (monthlyBudget.current_spend / monthlyBudget.limit_amount) * 100)
    : 0;

  // Financial Impact Calculations
  const totalAttemptedSpend = summary ? summary.dailySpend + summary.preventedSpend + summary.optimizedSavings : 0;
  const spendPct = totalAttemptedSpend > 0 ? (summary!.dailySpend / totalAttemptedSpend) * 100 : 0;
  const preventedPct = totalAttemptedSpend > 0 ? (summary!.preventedSpend / totalAttemptedSpend) * 100 : 0;
  const optimizedPct = totalAttemptedSpend > 0 ? (summary!.optimizedSavings / totalAttemptedSpend) * 100 : 0;

  // Max calculations for inline bars
  const maxModelCalls = summary && summary.models.length > 0 ? Math.max(...summary.models.map(m => m.request_count)) : 1;
  const maxProviderCalls = summary && summary.providers.length > 0 ? Math.max(...summary.providers.map(p => p.request_count)) : 1;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="brand-group">
          <h1 className="brand-title">TokenWall</h1>
          <span className="body-md" style={{ color: 'var(--on-surface-variant)' }}>Observability Console</span>
        </div>
        <div className="status-badge">
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
          {isConnected ? 'connected (127.0.0.1:1984)' : 'disconnected'}
        </div>
      </header>

      {!isConnected && (
        <section className="offline-card">
          <h2>TokenWall Interception Gateway Offline</h2>
          <p>
            The dashboard is unable to communicate with the background daemon. Make sure the proxy gateway is running.
          </p>
          <div style={{ marginTop: '8px' }}>
            <code className="console-box" style={{ display: 'inline-block', backgroundColor: 'rgba(0,0,0,0.1)', border: 'none' }}>
              npx tokenwall start
            </code>
          </div>
        </section>
      )}

      {/* Primary Spend & Prevention Summary Grid */}
      <section className="metrics-grid">
        <div className="metric-card">
          <span className="metric-title">Daily Spend</span>
          <span className="metric-value">
            ${summary ? summary.dailySpend.toFixed(4) : '0.0000'}
          </span>
          <span className="metric-subtext">
            Limit: ${summary ? summary.dailyLimit.toFixed(2) : '0.00'}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Prevented Runaways</span>
          <span className="metric-value" style={{ color: 'var(--error)' }}>
            ${summary ? summary.preventedSpend.toFixed(4) : '0.0000'}
          </span>
          <span className="metric-subtext">
            Runaway loops blocked
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Optimized Savings</span>
          <span className="metric-value" style={{ color: 'var(--secondary)' }}>
            ${summary ? summary.optimizedSavings.toFixed(4) : '0.0000'}
          </span>
          <span className="metric-subtext">
            Prompt compressions & auto-routing
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Saved Tokens</span>
          <span className="metric-value">
            {summary ? summary.savedTokens.toLocaleString() : '0'}
          </span>
          <span className="metric-subtext">
            Cumulative context compression
          </span>
        </div>
      </section>

      {/* Financial Impact Stacked Bar */}
      {totalAttemptedSpend > 0 && (
        <section className="card" style={{ padding: '24px' }}>
          <div style={{ marginBottom: '16px' }}>
            <span className="card-title">Financial Impact</span>
            <div className="body-md" style={{ color: 'var(--on-surface-variant)', marginTop: '4px' }}>
              Total attempted value: ${totalAttemptedSpend.toFixed(4)}
            </div>
          </div>
          
          <div className="stacked-bar-container">
            {spendPct > 0 && <div className="stacked-segment segment-spend" style={{ width: `${spendPct}%` }} title={`Actual Spend: $${summary!.dailySpend.toFixed(4)}`} />}
            {preventedPct > 0 && <div className="stacked-segment segment-prevented" style={{ width: `${preventedPct}%` }} title={`Prevented Spend: $${summary!.preventedSpend.toFixed(4)}`} />}
            {optimizedPct > 0 && <div className="stacked-segment segment-optimized" style={{ width: `${optimizedPct}%` }} title={`Optimized Savings: $${summary!.optimizedSavings.toFixed(4)}`} />}
          </div>
          
          <div className="stacked-legend">
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: 'var(--surface-tint)' }} />
              <span>Actual Spend ({spendPct.toFixed(1)}%)</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: 'var(--error)' }} />
              <span>Prevented Runaways ({preventedPct.toFixed(1)}%)</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: 'var(--secondary)' }} />
              <span>Optimized Savings ({optimizedPct.toFixed(1)}%)</span>
            </div>
          </div>
        </section>
      )}

      <div className="main-grid">
        {/* Left column: Budgets and Session List */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Budgets Progress */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Budget Allocation</span>
            </div>
            
            <div className="progress-container">
              <div className="progress-info">
                <span>Daily Limit</span>
                <span className="label-md">${dailyBudget ? dailyBudget.current_spend.toFixed(2) : '0.00'} / ${dailyBudget ? dailyBudget.limit_amount.toFixed(2) : '0.00'}</span>
              </div>
              <div className="progress-bar">
                <div 
                  className={`progress-fill ${dailyPercentage >= 100 ? 'warning' : ''}`} 
                  style={{ width: `${dailyPercentage}%` }}
                ></div>
              </div>
            </div>

            <div className="progress-container" style={{ marginTop: '8px' }}>
              <div className="progress-info">
                <span>Monthly Limit</span>
                <span className="label-md">${monthlyBudget ? monthlyBudget.current_spend.toFixed(2) : '0.00'} / ${monthlyBudget ? monthlyBudget.limit_amount.toFixed(2) : '0.00'}</span>
              </div>
              <div className="progress-bar">
                <div 
                  className={`progress-fill ${monthlyPercentage >= 100 ? 'warning' : ''}`} 
                  style={{ width: `${monthlyPercentage}%` }}
                ></div>
              </div>
            </div>
          </div>

          {/* Recent Agent Sessions */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Recent Sessions</span>
              <span className="badge">{sessions.length} active</span>
            </div>

            <div className="list-container">
              {sessions.length === 0 ? (
                <div style={{ color: 'var(--on-surface-variant)', fontSize: '13px', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>
                  No agent sessions logged yet.
                </div>
              ) : (
                sessions.map(s => (
                  <div 
                    key={s.sessionId}
                    className={`list-item ${selectedSession === s.sessionId ? 'selected' : ''}`}
                    onClick={() => setSelectedSession(s.sessionId)}
                  >
                    <div>
                      <div className="list-item-title">{s.sessionId.slice(0, 15)}...</div>
                      <div className="list-item-meta">
                        {s.requestsCount} requests • {s.blockedCount} blocked
                      </div>
                    </div>
                    <div className="list-item-value">${s.totalCost.toFixed(4)}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Active Workspaces */}
          {summary && summary.workspaces.length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Active Workspaces</span>
              </div>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th style={{ textAlign: 'right' }}>Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.workspaces.map(w => (
                      <tr key={w.project_id}>
                        <td style={{ wordBreak: 'break-all' }}>
                          <div style={{ fontWeight: 600 }}>{w.project_name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--on-surface-variant)' }}>{w.project_path}</div>
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                          ${w.total_spend.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </aside>

        {/* Right column: Timeline / Inspector */}
        <main style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="card" style={{ flexGrow: 1 }}>
            <div className="card-header">
              <span className="card-title">Forensic Timeline</span>
              {selectedSession && (
                <span className="badge" style={{ textTransform: 'none' }}>
                  Session ID: {selectedSession}
                </span>
              )}
            </div>

            {!selectedSession ? (
              <div style={{ color: 'var(--on-surface-variant)', fontStyle: 'italic', padding: '40px 0', textAlign: 'center' }}>
                Select an agent session on the left to view the granular interception log.
              </div>
            ) : events.length === 0 ? (
              <div style={{ color: 'var(--on-surface-variant)', fontStyle: 'italic', padding: '40px 0', textAlign: 'center' }}>
                No events recorded for this session.
              </div>
            ) : (
              <div className="timeline-container">
                {events.map((e, idx) => (
                  <div key={e.id || idx} className="timeline-event">
                    <div className="timeline-event-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span className={getEventBadgeClass(e.event_type)}>
                          {e.event_type.replace(/_/g, ' ')}
                        </span>
                        {e.model && (
                          <span className="label-sm" style={{ fontWeight: 600, color: 'var(--primary)' }}>
                            {e.model}
                          </span>
                        )}
                      </div>
                      <span className="timeline-event-time">
                        {new Date(e.created_at).toLocaleTimeString()}
                      </span>
                    </div>

                    <div className="timeline-event-meta">
                      {e.provider && <span>provider: {e.provider}</span>}
                      {e.request_id && <span>request_id: {e.request_id}</span>}
                    </div>

                    {e.metadata && (
                      <pre className="console-box">
                        {formatMetadata(e.metadata)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Model & Provider breakdown cards */}
          {summary && (summary.models.length > 0 || summary.providers.length > 0) && (
            <div className="timeline-layout">
              {/* Models Breakdown */}
              {summary.models.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Model Distribution</span>
                  </div>
                  <div className="table-container">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Calls</th>
                          <th style={{ textAlign: 'right' }}>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.models.map((m, idx) => (
                          <tr key={idx}>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 600 }}>
                              {m.model}
                            </td>
                            <td>
                              <div className="inline-bar-container">
                                <span style={{ width: '30px' }}>{m.request_count}</span>
                                <div className="inline-bar-track">
                                  <div className="inline-bar-fill bar-secondary" style={{ width: `${(m.request_count / maxModelCalls) * 100}%` }} />
                                </div>
                              </div>
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                              ${m.total_spend.toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Providers Breakdown */}
              {summary.providers.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Provider Distribution</span>
                  </div>
                  <div className="table-container">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Calls</th>
                          <th style={{ textAlign: 'right' }}>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.providers.map((p, idx) => (
                          <tr key={idx}>
                            <td style={{ textTransform: 'capitalize', fontWeight: 600 }}>
                              {p.provider}
                            </td>
                            <td>
                              <div className="inline-bar-container">
                                <span style={{ width: '30px' }}>{p.request_count}</span>
                                <div className="inline-bar-track">
                                  <div className="inline-bar-fill" style={{ width: `${(p.request_count / maxProviderCalls) * 100}%` }} />
                                </div>
                              </div>
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                              ${p.total_spend.toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
