import { useEffect, useState } from 'react';
import { api, fmtCost, fmtNum } from '../api.js';
import { AsyncButton, timeAgo } from '../components.jsx';

const TASKS = {
  writing: 'Writing replies',
  roleplay: 'Roleplay narration',
  impersonate: 'Write-for-me drafts',
  map: 'Map keeper',
  simplify: 'Scene simplifier',
  summary: 'Memory summaries',
  'doc-lookup': 'Document lookup checks',
  compile: 'Lorebook compiling',
  'lore-keeper': 'Lore keeper'
};

export default function Usage({ notify }) {
  const [u, setU] = useState(null);
  const load = () => api.get('/usage').then(setU);
  useEffect(() => { load(); }, []);
  if (!u) return null;
  const total = u.totals.reduce((s, t) => s + (t.cost || 0), 0);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Usage</h1>
        <AsyncButton className="danger" notify={notify} onClick={async () => { if (confirm('Clear the usage log?')) { await api.del('/usage'); load(); } }}>Clear log</AsyncButton>
      </header>
      <div className="grid2">
        <div className="card">
          <div className="muted small">Spent today</div>
          <div className="big-number">{fmtCost(u.today)}</div>
          <div className="muted small">{u.dailyLimit > 0 ? `of your ${fmtCost(u.dailyLimit)} daily limit` : 'No daily limit set'}</div>
          {u.dailyLimit > 0 && <div className="progress"><div style={{ width: `${Math.min(100, (u.today / u.dailyLimit) * 100)}%`, background: u.today >= u.dailyLimit ? 'var(--danger)' : undefined }} /></div>}
        </div>
        <div className="card">
          <div className="muted small">All time (as reported by OpenRouter)</div>
          <div className="big-number">{fmtCost(total)}</div>
          <div className="muted small">{fmtNum(u.totals.reduce((s, t) => s + t.calls, 0))} calls</div>
        </div>
      </div>
      <section className="card">
        <h2>By task</h2>
        <table>
          <thead><tr><th>Task</th><th>Calls</th><th>Prompt</th><th>Cached</th><th>Output</th><th>Cost</th></tr></thead>
          <tbody>
            {u.totals.map((t) => (
              <tr key={t.task}><td>{TASKS[t.task] || t.task}</td><td>{fmtNum(t.calls)}</td><td>{fmtNum(t.prompt)}</td><td>{fmtNum(t.cached)}</td><td>{fmtNum(t.completion)}</td><td>{fmtCost(t.cost)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>By model</h2>
        <table>
          <thead><tr><th>Model</th><th>Calls</th><th>Cost</th></tr></thead>
          <tbody>{u.byModel.map((m) => <tr key={m.model}><td>{m.model}</td><td>{fmtNum(m.calls)}</td><td>{fmtCost(m.cost)}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="card">
        <h2>Recent calls</h2>
        <table>
          <thead><tr><th>When</th><th>Task</th><th>Model</th><th>Tokens in / out</th><th>Cost</th></tr></thead>
          <tbody>
            {u.recent.map((r) => (
              <tr key={r.id}><td>{timeAgo(r.created_at)}</td><td>{TASKS[r.task] || r.task}</td><td className="ellipsis" style={{ maxWidth: 220 }}>{r.model}</td><td>{fmtNum(r.prompt_tokens)} / {fmtNum(r.completion_tokens)}</td><td>{fmtCost(r.cost)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
