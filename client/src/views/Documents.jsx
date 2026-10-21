import { useEffect, useRef, useState } from 'react';
import { api, upload, fmtCost, fmtNum } from '../api.js';
import { AsyncButton, Empty, Field, Modal, pickFiles, timeAgo } from '../components.jsx';

export default function Documents({ notify }) {
  const [docs, setDocs] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [compiling, setCompiling] = useState(null);
  const [paste, setPaste] = useState(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const refresh = () => api.get('/documents').then(setDocs);
  useEffect(() => { refresh(); }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="muted small" style={{ margin: '4px 0 0', maxWidth: 620 }}>
            Books, wikis, notes and drafts of any size (.txt, .md, .docx, .pdf, .html). They're indexed for full-text search and never sent whole: a chat only pulls the passages it needs
            when its lorebooks don't already cover something. You can also compile a document into a lorebook.
          </p>
        </div>
        <div className="row">
          <button onClick={() => setPaste({ name: '', text: '' })}>Paste text</button>
          <AsyncButton className="primary" notify={notify} busyLabel="Indexing…" onClick={async () => {
            const files = await pickFiles({ accept: '.txt,.md,.markdown,.docx,.pdf,.html,.htm' });
            if (!files.length) return;
            const added = await upload('/documents', files);
            notify(`Indexed ${added.map((d) => `${d.name} (${d.chunks} passages)`).join(', ')}`);
            refresh();
          }}>⤒ Upload</AsyncButton>
        </div>
      </header>

      {docs.length > 0 && (
        <form className="row" style={{ marginBottom: 14 }} onSubmit={async (e) => { e.preventDefault(); setHits(q.trim() ? await api.get(`/documents/search?q=${encodeURIComponent(q)}`) : null); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all documents…" />
          <button type="submit">Search</button>
        </form>
      )}
      {hits && (
        <div className="col" style={{ marginBottom: 18 }}>
          {!hits.length && <span className="muted small">No matches.</span>}
          {hits.map((h) => (
            <div key={`${h.document_id}:${h.idx}`} className="search-hit">
              <b>{h.doc}{h.heading ? ` — ${h.heading}` : ''}</b>
              <div className="body">{h.body}</div>
            </div>
          ))}
        </div>
      )}

      {!docs.length ? (
        <Empty icon="📄" title="No documents yet">Upload your story so far, a series bible, a wiki export, or research notes.</Empty>
      ) : (
        <div className="list">
          {docs.map((d) => (
            <div key={d.id} className="list-item">
              <span style={{ fontSize: 22 }}>📄</span>
              <div className="grow">
                <div className="bold ellipsis">{d.name}</div>
                <div className="tiny muted">{fmtNum(d.tokens)} tokens · {fmtNum(d.chunks)} searchable passages · added {timeAgo(d.created_at)}</div>
              </div>
              <button className="small" onClick={() => setViewing(d.id)}>View</button>
              <button className="small" onClick={() => setCompiling(d)}>📚 Compile to lorebook</button>
              <AsyncButton className="small danger" notify={notify} onClick={async () => {
                if (!confirm(`Delete ${d.name}? Chats using it will stop searching it.`)) return;
                await api.del(`/documents/${d.id}`);
                refresh();
              }}>Delete</AsyncButton>
            </div>
          ))}
        </div>
      )}

      {viewing && <Viewer id={viewing} onClose={() => setViewing(null)} />}
      {compiling && <Compile doc={compiling} notify={notify} onClose={() => setCompiling(null)} />}
      {paste && (
        <Modal title="Paste text as a document" onClose={() => setPaste(null)} footer={
          <AsyncButton className="primary" notify={notify} onClick={async () => {
            await api.post('/documents', { name: paste.name || 'Pasted text', text: paste.text });
            setPaste(null);
            refresh();
          }}>Add</AsyncButton>
        }>
          <Field label="Name"><input value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} /></Field>
          <Field label="Text"><textarea rows={14} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function Viewer({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/documents/${id}`).then(setD); }, [id]);
  return (
    <Modal title={d?.name || 'Document'} wide onClose={onClose}>
      {d && (
        <>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--prose-font)', fontSize: 14, lineHeight: 1.6 }}>{d.text}</pre>
          {d.truncated && <p className="muted small">Showing the first 60,000 characters of {fmtNum(d.chars)}.</p>}
        </>
      )}
    </Modal>
  );
}

function Compile({ doc, notify, onClose }) {
  const [books, setBooks] = useState([]);
  const [target, setTarget] = useState('');
  const [instructions, setInstructions] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [job, setJob] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    api.get('/lorebooks').then((b) => setBooks(b.filter((x) => !x.character_id)));
    return () => clearInterval(timer.current);
  }, []);

  const start = async () => {
    const j = await api.post(`/documents/${doc.id}/compile`, { lorebookId: target ? Number(target) : null, instructions });
    setJob(j);
    timer.current = setInterval(async () => {
      const s = await api.get(`/jobs/${j.id}`);
      setJob({ ...s, lorebookId: j.lorebookId });
      if (s.status !== 'running') {
        clearInterval(timer.current);
        notify(`Compiled ${s.added} new entries${s.errors.length ? ` (${s.errors.length} chunks failed)` : ''}`, s.errors.length && !s.added ? 'error' : 'info');
      }
    }, 1500);
  };

  return (
    <Modal title={`Compile "${doc.name}" into a lorebook`} onClose={onClose} footer={
      job ? <button onClick={onClose}>{job.status === 'running' ? 'Run in background' : 'Close'}</button> : (
        <>
          <AsyncButton notify={notify} onClick={async () => setEstimate(await api.get(`/documents/${doc.id}/compile/estimate?instructions=${encodeURIComponent(instructions)}`))}>Estimate cost</AsyncButton>
          <AsyncButton className="primary" notify={notify} onClick={start}>Compile with AI</AsyncButton>
        </>
      )
    }>
      <p className="small muted" style={{ marginTop: 0 }}>The utility model reads the document once, in chunks, and writes dense keyword-triggered entries (characters keep sample dialogue for their voice). You pay for this once.</p>
      <Field label="Into">
        <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!!job}>
          <option value="">A new lorebook</option>
          {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="Instructions (optional)" hint="e.g. 'One entry per character and location. Skip the appendix. Use the characters' full names as keys.'">
        <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={!!job} />
      </Field>
      {estimate && !job && (
        <div className="callout small">
          {estimate.chunks} chunks · ~{fmtNum(estimate.inputTokens)} tokens in, ~{fmtNum(estimate.outputTokens)} out with <b>{estimate.model}</b> · estimated <b>{fmtCost(estimate.estimatedCost)}</b>
        </div>
      )}
      {job && (
        <>
          <div className="progress"><div style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} /></div>
          <div className="small muted">{job.status === 'running' ? `Chunk ${job.done} of ${job.total}…` : `Done: ${job.added} new entries.`} {job.errors?.length ? <span className="danger-text">{job.errors.length} errors</span> : null}</div>
          {job.errors?.length > 0 && <pre className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{job.errors.slice(0, 5).join('\n')}</pre>}
        </>
      )}
    </Modal>
  );
}
