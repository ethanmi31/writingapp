import { useEffect, useState } from 'react';
import { api, fmtNum } from '../api.js';
import { AsyncButton, Modal } from '../components.jsx';

const PARTS = [
  ['system', 'System prompt', '#8b7bff'],
  ['definitions', 'Cards & notes', '#c79bff'],
  ['lore', 'Lore', '#3fbf7f'],
  ['state', 'Map / manuscript', '#ff8a5c'],
  ['documents', 'Documents', '#5ec8ff'],
  ['summary', 'Summary', '#e8b84a'],
  ['history', 'Chat history', '#8c93a6']
];
const REASON = { constant: 'always on', sticky: 'sticky', keyword: 'keyword', recursion: 'via other entry' };

/** What went into a reply: token breakdown, lore that fired (and why), document lookups, memory. */
export default function ContextPanel({ chat, setChat, message, live, notify }) {
  const meta = (live?.meta && !live.targetId ? live.meta : null) || message?.meta || {};
  const [preview, setPreview] = useState(null);
  const [summary, setSummary] = useState(chat.summary || '');
  useEffect(() => setSummary(chat.summary || ''), [chat.summary]);
  const t = meta.tokens || {};
  const total = PARTS.reduce((s, [k]) => s + (t[k] || 0), 0) || 1;
  const fired = (meta.lore || []).filter((x) => !x.skipped);
  const skipped = (meta.lore || []).filter((x) => x.skipped);
  const docs = meta.docs || {};

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row space">
        <h3 style={{ margin: 0 }}>{live?.meta && !live.targetId ? 'Reply being written' : message ? 'Last reply' : 'Context'}</h3>
        <AsyncButton className="small" notify={notify} busyLabel="Building…" onClick={async () => setPreview(await api.post(`/chats/${chat.id}/prompt`, { kind: 'reply' }))}>
          👁 Preview next prompt
        </AsyncButton>
      </div>
      {!meta.tokens ? (
        <p className="muted small">Send a message, then this shows exactly what the AI was given: which lore entries fired and why, which document passages were looked up, and how the context was spent.</p>
      ) : (
        <>
          <div className="small muted">
            {meta.model && <>Model: <b>{meta.model}</b> · </>}~{fmtNum(t.total)} prompt tokens · {meta.historyMessages} messages verbatim
            {meta.dropped > 0 && <>, {meta.dropped} older ones covered by the summary</>}
          </div>
          <div className="ctx-bar">
            {PARTS.map(([k, , color]) => (t[k] ? <div key={k} style={{ width: `${(t[k] / total) * 100}%`, background: color }} title={`${k}: ${t[k]}`} /> : null))}
          </div>
          <div className="ctx-legend">
            {PARTS.map(([k, label, color]) => (t[k] ? <span key={k}><i className="legend-dot" style={{ background: color }} />{label} {fmtNum(t[k])}</span> : null))}
          </div>

          <h3>Lore ({fired.length})</h3>
          {!fired.length && <p className="muted small">No lorebook entries fired.</p>}
          <div className="ctx-list">
            {fired.map((x) => (
              <div key={x.id} className="ctx-item">
                <span className="bold">{x.title}</span>
                <span className="tiny muted">{x.book}</span>
                <span className="why">{REASON[x.reason] || x.reason}{x.key ? `: "${x.key}"` : ''} · {x.tokens} tok{x.position && x.position !== 'before' ? ` · ${x.position}` : ''}</span>
              </div>
            ))}
            {skipped.map((x, i) => (
              <div key={`s${i}`} className="ctx-item skipped">
                <span>{x.title}</span>
                <span className="why">{x.skipped}</span>
              </div>
            ))}
          </div>

          <h3>Document lookup</h3>
          <p className="small" style={{ margin: 0 }}>
            {docs.mode === 'off' ? 'Off for this chat.' : docs.reason || 'No documents attached.'}
            {docs.queries?.length > 0 && <span className="muted"> · searched: {docs.queries.join(', ')}</span>}
          </p>
          <div className="ctx-list">
            {(docs.chunks || []).map((c) => (
              <div key={`${c.document_id}:${c.idx}`} className="ctx-item" title={c.preview}>
                <span className="ellipsis">{c.doc}{c.heading ? ` — ${c.heading}` : ''}</span>
                <span className="why">{docs.pinned?.some((p) => p.document_id === c.document_id && p.idx === c.idx) ? '📌 ' : ''}{c.tokens} tok</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Memory</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        When the chat outgrows the context budget, older messages are folded into this summary by the utility model. Edit it freely — it's sent instead of those messages.
      </p>
      <textarea rows={7} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="(Nothing summarized yet.)" />
      <div className="row">
        <AsyncButton className="small" disabled={summary === (chat.summary || '')} notify={notify} onClick={async () => {
          await api.put(`/chats/${chat.id}`, { summary });
          setChat((c) => ({ ...c, summary }));
          notify('Summary saved');
        }}>Save summary</AsyncButton>
      </div>

      <LoreKeeper chat={chat} notify={notify} />

      {preview && (
        <Modal title="Next prompt" wide onClose={() => setPreview(null)}>
          <p className="muted small" style={{ marginTop: 0 }}>Exactly what the model will receive if you send now (lore timers aren't started by previewing). ~{fmtNum(preview.meta.tokens.total)} tokens.</p>
          <div className="prompt-view">
            {preview.messages.map((m, i) => (
              <div key={i} className="prompt-msg">
                <div className="role"><span>{m.role}</span><span>~{fmtNum(Math.ceil(m.content.length / 3.6))} tok</span></div>
                <pre>{m.content}</pre>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Proposes lorebook entries for facts the story established that no entry covers yet. */
function LoreKeeper({ chat, notify }) {
  const [books, setBooks] = useState([]);
  const [target, setTarget] = useState('');
  const [found, setFound] = useState(null);
  const [picked, setPicked] = useState(new Set());
  useEffect(() => {
    api.get('/lorebooks').then((b) => {
      const own = b.filter((x) => !x.character_id);
      setBooks(own);
      setTarget((t) => t || String(chat.lorebook_ids.find((id) => own.some((x) => x.id === id)) || own[0]?.id || ''));
    });
  }, []);
  return (
    <>
      <h3>Lore keeper</h3>
      <p className="hint" style={{ marginTop: 0 }}>Reads the recent story and suggests new lorebook entries for characters, places and facts it invented, so they stay consistent later.</p>
      <div className="row">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">New lorebook for this chat</option>
          {books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <AsyncButton className="small" notify={notify} busyLabel="Reading…" onClick={async () => {
          const r = await api.post(`/chats/${chat.id}/lore-suggest`, { lorebookId: target ? Number(target) : null });
          setFound(r.entries);
          setPicked(new Set(r.entries.map((_, i) => i)));
          if (!r.entries.length) notify('Nothing new worth adding.');
        }}>Suggest entries</AsyncButton>
      </div>
      {found?.length > 0 && (
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          {found.map((e, i) => (
            <label key={i} className="search-hit" style={{ cursor: 'pointer' }}>
              <div className="row">
                <input type="checkbox" checked={picked.has(i)} onChange={() => { const s = new Set(picked); s.has(i) ? s.delete(i) : s.add(i); setPicked(s); }} />
                <b>{e.title}</b>
                <span className="tag">{e.category}</span>
                {e.update_of && <span className="tag">extends {e.update_of}</span>}
              </div>
              <div className="tiny muted">keys: {(e.keys || []).join(', ')}</div>
              <div className="body open">{e.content}</div>
            </label>
          ))}
          <AsyncButton className="primary small" disabled={!picked.size} notify={notify} onClick={async () => {
            let bookId = Number(target);
            if (!bookId) {
              bookId = (await api.post('/lorebooks', { name: `${chat.title} — lore` })).id;
              await api.put(`/chats/${chat.id}`, { lorebook_ids: [...chat.lorebook_ids, bookId] });
            }
            await api.post(`/lorebooks/${bookId}/entries`, found.filter((_, i) => picked.has(i)).map((e) => ({ title: e.title, keys: e.keys, content: e.content, category: e.category })));
            notify(`Added ${picked.size} entr${picked.size === 1 ? 'y' : 'ies'}`);
            setFound(null);
          }}>Add {picked.size} to lorebook</AsyncButton>
        </div>
      )}
    </>
  );
}
