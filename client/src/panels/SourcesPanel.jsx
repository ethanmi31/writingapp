import { useEffect, useState } from 'react';
import { api, upload, fmtNum } from '../api.js';
import { AsyncButton, pickFiles } from '../components.jsx';

export const DOC_MODES = [
  ['ai', 'Smart (AI checks what the lore is missing)'],
  ['auto', 'Free (looks up names the lore doesn\'t cover)'],
  ['always', 'Always search the documents'],
  ['off', 'Off']
];

/** Lorebooks and documents attached to this chat, plus manual document search and pinning. */
export default function SourcesPanel({ chat, setChat, patchChat, notify, openSettings }) {
  const [books, setBooks] = useState([]);
  const [docs, setDocs] = useState([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [open, setOpen] = useState(null);

  const loadLists = () => {
    api.get('/lorebooks').then(setBooks).catch(() => {});
    api.get('/documents').then(setDocs).catch(() => {});
  };
  useEffect(loadLists, []);

  const toggle = (key, id) => {
    const cur = chat[key];
    return patchChat({ [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const pinned = chat.pinned || [];
  const isPinned = (h) => pinned.some((p) => p.document_id === h.document_id && p.idx === h.idx);
  const togglePin = (h) => patchChat({ pinned: isPinned(h) ? pinned.filter((p) => !(p.document_id === h.document_id && p.idx === h.idx)) : [...pinned, { document_id: h.document_id, idx: h.idx, doc: h.doc, heading: h.heading }] });

  const search = async (e) => {
    e?.preventDefault();
    if (!q.trim()) return setHits(null);
    const ids = chat.document_ids.length ? chat.document_ids : docs.map((d) => d.id);
    setHits(await api.get(`/documents/search?q=${encodeURIComponent(q)}&ids=${ids.join(',')}`));
  };

  const characterBooks = books.filter((b) => b.character_id && chat.character_ids.includes(b.character_id));
  const docMode = chat.options.docMode;

  return (
    <div className="col" style={{ gap: 4 }}>
      <h3 style={{ marginTop: 0 }}>Lorebooks</h3>
      <p className="hint" style={{ marginTop: 0 }}>Entries are pulled in when their keywords come up (in the chat{chat.mode === 'roleplay' ? ', your current location and who\'s with you' : ' and the end of your manuscript'}).</p>
      <div className="pick-list">
        {books.filter((b) => !b.character_id).map((b) => (
          <label key={b.id} className={`pick ${chat.lorebook_ids.includes(b.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={chat.lorebook_ids.includes(b.id)} onChange={() => toggle('lorebook_ids', b.id).catch((e) => notify(e.message, 'error'))} />
            <span className="grow">{b.name}</span>
            <span className="tiny muted">{b.entryCount} entries</span>
          </label>
        ))}
        {characterBooks.map((b) => (
          <label key={b.id} className="pick on" title="Comes with a character in this chat">
            <input type="checkbox" checked disabled />
            <span className="grow">{b.name}</span>
            <span className="tiny muted">from {b.characterName}</span>
          </label>
        ))}
        {!books.length && <span className="muted small" style={{ padding: 8 }}>No lorebooks yet — create or import them under Lorebooks.</span>}
      </div>

      <h3>Source documents</h3>
      <p className="hint" style={{ marginTop: 0 }}>Never sent whole. Searched only for what the lorebooks don't cover, and only the matching passages are sent.</p>
      <div className="pick-list">
        {docs.map((d) => (
          <label key={d.id} className={`pick ${chat.document_ids.includes(d.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={chat.document_ids.includes(d.id)} onChange={() => toggle('document_ids', d.id).catch((e) => notify(e.message, 'error'))} />
            <span className="grow ellipsis">{d.name}</span>
            <span className="tiny muted">{fmtNum(d.tokens)} tok</span>
          </label>
        ))}
        {!docs.length && <span className="muted small" style={{ padding: 8 }}>No documents yet.</span>}
      </div>
      <div className="row wrap">
        <AsyncButton className="small" notify={notify} busyLabel="Uploading…" onClick={async () => {
          const files = await pickFiles({ accept: '.txt,.md,.markdown,.docx,.pdf,.html,.htm' });
          if (!files.length) return;
          const added = await upload(`/documents?chat=${chat.id}`, files);
          notify(`Added ${added.map((d) => d.name).join(', ')}`);
          loadLists();
          setChat((c) => ({ ...c, document_ids: [...new Set([...c.document_ids, ...added.map((d) => d.id)])] }));
        }}>⤒ Upload & attach</AsyncButton>
        <select className="grow" value={docMode ?? ''} onChange={(e) => patchChat({ options: { ...chat.options, docMode: e.target.value || undefined } })} style={{ fontSize: 12.5, padding: '5px 8px' }}>
          <option value="">Lookup: app default</option>
          {DOC_MODES.map(([v, l]) => <option key={v} value={v}>Lookup: {l}</option>)}
        </select>
      </div>

      <h3>Search & pin passages</h3>
      <form className="row" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your documents…" />
        <button type="submit">Search</button>
      </form>
      {pinned.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 6 }}>
          <span className="small muted">📌 Pinned — always in context:</span>
          {pinned.map((p) => (
            <div key={`${p.document_id}:${p.idx}`} className="row small">
              <span className="grow ellipsis">{p.doc}{p.heading ? ` — ${p.heading}` : ''} #{p.idx + 1}</span>
              <button className="ghost small" onClick={() => togglePin(p)}>Unpin</button>
            </div>
          ))}
        </div>
      )}
      {hits && (
        <div className="col" style={{ gap: 6, marginTop: 8 }}>
          {!hits.length && <span className="muted small">No matches.</span>}
          {hits.map((h) => {
            const key = `${h.document_id}:${h.idx}`;
            return (
              <div key={key} className={`search-hit ${isPinned(h) ? 'pinned' : ''}`}>
                <div className="row space">
                  <b className="ellipsis">{h.doc}{h.heading ? ` — ${h.heading}` : ''}</b>
                  <span className="row">
                    <span className="tiny muted">{h.tokens} tok</span>
                    <button className="small" onClick={() => togglePin(h).catch((e) => notify(e.message, 'error'))}>{isPinned(h) ? 'Unpin' : '📌 Pin'}</button>
                  </span>
                </div>
                <div className={`body ${open === key ? 'open' : ''}`} onClick={() => setOpen(open === key ? null : key)}>{h.body}</div>
              </div>
            );
          })}
        </div>
      )}
      <p className="hint" style={{ marginTop: 14 }}>Budgets and more options: <a onClick={openSettings}>chat settings → Lore & sources</a>.</p>
    </div>
  );
}
