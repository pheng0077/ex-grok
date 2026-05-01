import { useEffect, useState } from 'react';
import type { AppState } from '@/lib/contracts';
import {
  getRuntimeState,
  openDashboardPage,
  openGrokComposerPage,
  subscribeToRuntimeState,
} from '@/lib/runtime';
import './App.css';

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void refresh();
    return subscribeToRuntimeState((nextState) => {
      setState(nextState);
      setLoading(false);
    });
  }, []);

  async function refresh() {
    setLoading(true);

    try {
      setState(await getRuntimeState());
    } finally {
      setLoading(false);
    }
  }

  async function openGrok(): Promise<void> {
    await openGrokComposerPage();
  }

  const queue = state?.queue ?? [];
  const queuedCount = queue.filter((job) => job.status === 'queued').length;
  const completedCount = queue.filter(
    (job) => job.status === 'downloaded',
  ).length;
  const pageStatus = state?.grokPage?.readyForAutomation
    ? 'Connected to Grok composer'
    : 'Open grok.com to start automation';

  return (
    <main className="popup-app">
      <section className="surface hero-card">
        <div className="hero-copy">
          <div className="hero-brand">
            <img src="/icon/source.svg" alt="Ex Grok logo" className="brand-mark brand-mark-popup" />
            <div>
              <p className="eyebrow">Ex Grok</p>
              <h1>Batch video control</h1>
            </div>
          </div>
          <p className="muted">
            Queue text-to-video or frame-to-video runs, then hand them off to
            the side panel dashboard.
          </p>
        </div>
        <span className="tag">Sequential mode</span>
      </section>

      <section className="surface stat-grid">
        <div className="stat-card">
          <span className="stat-label">Queued</span>
          <strong>{queuedCount}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Downloaded</span>
          <strong>{completedCount}</strong>
        </div>
      </section>

      <section className="surface status-card">
        <div className="status-row">
          <span className="status-dot" />
          <strong>{loading ? 'Syncing state...' : pageStatus}</strong>
        </div>
        <p className="muted small-copy">
          Prompt groups are split by blank lines so single line breaks stay
          inside the same prompt.
        </p>
      </section>

      <section className="button-row popup-actions">
        <button onClick={() => void openDashboardPage()}>Open dashboard</button>
        <button className="ghost" onClick={() => void openGrok()}>
          Open grok.com
        </button>
      </section>

      <section className="surface queue-card">
        <div className="queue-card-header">
          <h2>Recent jobs</h2>
          <button className="ghost compact" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {queue.length ? (
          <ul className="queue-list">
            {queue.slice(0, 4).map((job) => (
              <li key={job.id} className="queue-item">
                <span className="queue-item-copy">{job.prompt}</span>
                <span className={`queue-status ${job.status}`}>{job.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted empty-state">
            No jobs queued yet. Open the dashboard to build your first batch.
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
