import React, { useEffect, useState } from 'react';
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

const API_BASE = 'http://localhost:1984/api/admin';

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [events, setEvents] = useState<GovernanceEvent[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/sessions`)
      .then(res => res.json())
      .then(data => setSessions(data))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (selectedSession) {
      fetch(`${API_BASE}/events/${selectedSession}`)
        .then(res => res.json())
        .then(data => setEvents(data))
        .catch(console.error);
    }
  }, [selectedSession]);

  const totalSpend = sessions.reduce((sum, s) => sum + s.totalCost, 0);
  const totalBlocked = sessions.reduce((sum, s) => sum + s.blockedCount, 0);
  const totalSaved = sessions.reduce((sum, s) => sum + s.tokensSaved, 0);

  return (
    <div className="dashboard-container">
      <header>
        <h1>TokenWall Observability</h1>
      </header>

      <section className="metrics-grid">
        <div className="metric-card">
          <div className="metric-title">Total Spend</div>
          <div className="metric-value" style={{ color: 'var(--accent)' }}>${totalSpend.toFixed(4)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-title">Blocked Requests</div>
          <div className="metric-value" style={{ color: 'var(--danger)' }}>{totalBlocked}</div>
        </div>
        <div className="metric-card">
          <div className="metric-title">Tokens Saved</div>
          <div className="metric-value" style={{ color: 'var(--success)' }}>{totalSaved}</div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
        <div>
          <h2 className="section-title">Recent Sessions</h2>
          <div className="events-list">
            {sessions.map(s => (
              <div 
                key={s.sessionId} 
                className="event-item" 
                style={{ cursor: 'pointer', border: selectedSession === s.sessionId ? '1px solid var(--accent)' : '' }}
                onClick={() => setSelectedSession(s.sessionId)}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{s.sessionId}</div>
                  <div className="event-meta">{s.requestsCount} reqs • {s.blockedCount} blocked</div>
                </div>
                <div style={{ fontWeight: 700 }}>${s.totalCost.toFixed(4)}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="section-title">Forensic Timeline {selectedSession && `(${selectedSession})`}</h2>
          {!selectedSession ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Select a session to view its event timeline.</div>
          ) : (
            <div className="events-list">
              {events.map(e => (
                <div key={e.id} className="event-item">
                  <div>
                    <span className={`event-type ${e.event_type}`}>{e.event_type}</span>
                    <div className="event-meta" style={{ marginTop: '0.5rem' }}>
                      <span>Req: {e.request_id?.slice(0,6) || 'none'}</span>
                      <span>{e.provider || 'system'}</span>
                      <span>{e.model || ''}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.75rem', maxWidth: '300px', wordBreak: 'break-all', color: 'var(--text-muted)' }}>
                    {e.metadata}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
