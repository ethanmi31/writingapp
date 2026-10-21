import { useEffect, useMemo, useState } from 'react';
import { api, upload, fmtNum, tokens as tokenCount } from '../api.js';
import { AsyncButton, Field, Toggle, pickFiles, Empty } from '../components.jsx';

const LOGIC = [
  ['and_any', 'AND ANY — needs at least one'],
  ['and_all', 'AND ALL — needs all of them'],
  ['not_any', 'NOT ANY — none of them may appear'],
  ['not_all', 'NOT ALL — not all of them together']
];
const POSITIONS = [
  ['before', 'Before the character/story definitions'],
  ['after', 'After the definitions'],
  ['an', "With the author's note (near the end)"],
  ['depth', 'At a depth in the chat']
];

export default function Lorebooks({ notify }) {
  const [books, setBooks] = useState([]);
  const [current, setCurrent] = useState(null);
  const refresh = () => api.get('/lorebooks').then((b) => {
    setBooks(b);
    setCurrent((c) => (b.some((x) => x.id === c) ? c : b[0]?.id ?? null));
  });
  useEffect(() => { refresh(); }, []);

  const importFiles = async (into) => {
    const files = await pickFiles({ accept: '.json,.png' });
    if (!files.length) return;
    const r = await upload(`/lorebooks/import${into ? `?into=${into}` : ''}`, files);
    const ok = r.filter((x) => !x.error);
    const bad = r.filter((x) => x.error);
    notify(`${ok.reduce((s, x) => s + x.imported, 0)} entries imported${ok.some((x) => x.skipped) ? ` (${ok.reduce((s, x) => s + x.skipped, 0)} duplicates skipped)` : ''}${bad.length ? `. ${bad.map((b) => `${b.file}: ${b.error}`).join(' ')}` : ''}`, bad.length ? 'error' : 'info');
    await refresh();
    if (ok[0]?.lorebookId) setCurrent(ok[0].lorebookId);
  };

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <header className="page-head">
        <div>
          <h1>Lorebooks</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>World info that's injected only when its keywords come up — compatible with SillyTavern World Info (import & export).</p>
        </div>
        <div className="row">
          <AsyncButton notify={notify} onClick={() => importFiles(null)}>⤒ Import (SillyTavern .json / card .png)</AsyncButton>
          <AsyncButton className="primary" notify={notify} onClick={async () => {
            const b = await api.post('/lorebooks', { name: 'New lorebook' });
            await refresh();
            setCurrent(b.id);
          }}>＋ New lorebook</AsyncButton>
        </div>
      </header>
      {!books.length ? (
        <Empty icon="📚" title="No lorebooks yet">
          Create one, import a SillyTavern World Info file, or compile one from a document under <b>Documents</b>.
        </Empty>
      ) : (
        <div className="split">
          <div className="list">
            {books.map((b) => (
              <div key={b.id} className={`list-item clickable ${current === b.id ? 'active' : ''}`} onClick={() => setCurrent(b.id)}>
                <div className="grow">
                  <div className="bold ellipsis">{b.name}</div>
                  <div className="tiny muted">{b.entryCount} entr{b.entryCount === 1 ? 'y' : 'ies'} · {fmtNum(b.tokenCount)} tok{b.characterName ? ` · ${b.characterName}'s card` : ''}</div>
                </div>
              </div>
            ))}
          </div>
          {current && <Book key={current} id={current} notify={notify} onChanged={refresh} onImport={() => importFiles(current)} />}
        </div>
      )}
    </div>
  );
}

function Book({ id, notify, onChanged, onImport }) {
  const [book, setBook] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [test, setTest] = useState('');
  const [testResult, setTestResult] = useState(null);
  const load = () => api.get(`/lorebooks/${id}`).then(setBook);
  useEffect(() => { load(); }, [id]);

  const filtered = useMemo(() => {
    if (!book) return [];
    const s = q.trim().toLowerCase();
    return s ? book.entries.filter((e) => `${e.title} ${e.keys.join(' ')} ${e.content} ${e.category}`.toLowerCase().includes(s)) : book.entries;
  }, [book, q]);
  if (!book) return null;

  const saveBook = async (patch) => {
    await api.put(`/lorebooks/${id}`, patch);
    setBook({ ...book, ...patch });
    onChanged();
  };
  const runTest = async () => setTestResult(await api.post('/lorebooks/test', { lorebookIds: [id], text: test }));

  return (
    <div>
      <div className="card">
        <div className="grid2">
          <Field label="Name"><input defaultValue={book.name} onBlur={(e) => e.target.value !== book.name && saveBook({ name: e.target.value })} /></Field>
          <Field label="Description"><input defaultValue={book.description} onBlur={(e) => e.target.value !== book.description && saveBook({ description: e.target.value })} /></Field>
        </div>
        <div className="grid3">
          <Field label="Scan depth" hint="Messages scanned for keywords. Blank = Settings default."><input type="number" min={0} defaultValue={book.scan_depth ?? ''} onBlur={(e) => saveBook({ scan_depth: e.target.value })} /></Field>
          <Field label="Token budget" hint="Cap for this book per message. Blank = no extra cap."><input type="number" min={0} defaultValue={book.token_budget ?? ''} onBlur={(e) => saveBook({ token_budget: e.target.value })} /></Field>
          <div style={{ paddingTop: 18 }}><Toggle checked={!!book.recursive} onChange={(v) => saveBook({ recursive: v })} label="Recursive" hint="Entries can trigger other entries." /></div>
        </div>
        <div className="row wrap">
          <AsyncButton className="primary small" notify={notify} onClick={async () => {
            const [e] = await api.post(`/lorebooks/${id}/entries`, { title: 'New entry', keys: [], content: '' });
            await load();
            setOpen(e.id);
            onChanged();
          }}>＋ Entry</AsyncButton>
          <AsyncButton className="small" notify={notify} onClick={onImport}>⤒ Import into this book</AsyncButton>
          <a className="button small-btn" href={`/api/lorebooks/${id}/export`}>⤓ Export (SillyTavern)</a>
          <span className="grow" />
          <AsyncButton className="small danger" notify={notify} onClick={async () => {
            if (!confirm(`Delete "${book.name}" and its ${book.entries.length} entries?`)) return;
            await api.del(`/lorebooks/${id}`);
            onChanged();
          }}>Delete book</AsyncButton>
        </div>
      </div>

      <details className="card">
        <summary className="bold">🧪 Test activation</summary>
        <p className="hint">Paste a message to see which entries would fire, and why.</p>
        <textarea rows={3} value={test} onChange={(e) => setTest(e.target.value)} placeholder="Mira walked into the Rusty Anchor…" />
        <div className="row" style={{ marginTop: 6 }}>
          <AsyncButton className="small" notify={notify} onClick={runTest}>Test</AsyncButton>
          {testResult && <span className="small muted">{testResult.trace.filter((t) => !t.skipped).length} fired · {testResult.tokens} tokens</span>}
        </div>
        {testResult && (
          <div className="ctx-list" style={{ marginTop: 8 }}>
            {testResult.trace.map((t, i) => (
              <div key={i} className={`ctx-item ${t.skipped ? 'skipped' : ''}`}>
                <span className="bold">{t.title}</span>
                <span className="why">{t.skipped || `${t.reason}${t.key ? `: "${t.key}"` : ''}`}</span>
              </div>
            ))}
          </div>
        )}
      </details>

      <input className="search" placeholder={`Search ${book.entries.length} entries…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      {filtered.map((e) => (
        <Entry key={e.id} entry={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} notify={notify}
          onSaved={(n) => setBook((b) => ({ ...b, entries: b.entries.map((x) => (x.id === n.id ? n : x)) }))}
          onDeleted={() => { setBook((b) => ({ ...b, entries: b.entries.filter((x) => x.id !== e.id) })); onChanged(); }} />
      ))}
      {!filtered.length && <p className="muted small">No entries{q ? ' match' : ''}.</p>}
    </div>
  );
}

function Entry({ entry, open, onToggle, notify, onSaved, onDeleted }) {
  const [e, setE] = useState(entry);
  const [keys, setKeys] = useState(entry.keys.join(', '));
  const [secondary, setSecondary] = useState(entry.secondary_keys.join(', '));
  useEffect(() => { setE(entry); setKeys(entry.keys.join(', ')); setSecondary(entry.secondary_keys.join(', ')); }, [entry]);
  const dirty = JSON.stringify({ ...e, keys, secondary }) !== JSON.stringify({ ...entry, keys: entry.keys.join(', '), secondary: entry.secondary_keys.join(', ') });
  const set = (k) => (ev) => setE({ ...e, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value });
  const tri = (k) => (ev) => setE({ ...e, [k]: ev.target.value === '' ? null : ev.target.value === '1' });
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const badRegex = split(keys).concat(split(secondary)).filter((k) => {
    const m = k.match(/^\/(.+)\/([a-z]*)$/s);
    if (!m) return false;
    try { new RegExp(m[1], m[2]); return false; } catch { return true; }
  });

  const save = async () => {
    const saved = await api.put(`/entries/${e.id}`, { ...e, keys: split(keys), secondary_keys: split(secondary) });
    onSaved(saved);
    notify('Entry saved');
  };
  const quick = async (patch) => onSaved(await api.put(`/entries/${e.id}`, patch));

  return (
    <div className={`lore-entry ${entry.enabled ? '' : 'off'}`}>
      <div className="lore-entry-head" onClick={onToggle}>
        <span onClick={(ev) => ev.stopPropagation()}><input type="checkbox" title="Enabled" checked={entry.enabled} onChange={(ev) => quick({ enabled: ev.target.checked })} /></span>
        <span className="bold">{entry.title || '(untitled)'}</span>
        {entry.constant && <span className="tag const">always on</span>}
        {entry.category && <span className="tag">{entry.category}</span>}
        {entry.modes !== 'both' && <span className="tag">{entry.modes} only</span>}
        <span className="keys ellipsis grow">{entry.constant ? '' : entry.keys.join(', ') || <i className="danger-text">no keys — never fires</i>}</span>
        <span className="tiny muted">{entry.tokens} tok</span>
      </div>
      {open && (
        <div className="lore-entry-body">
          <div className="grid2" style={{ marginTop: 10 }}>
            <Field label="Title / memo"><input value={e.title} onChange={set('title')} /></Field>
            <Field label="Category"><input value={e.category} onChange={set('category')} placeholder="Character, Location, Faction…" /></Field>
          </div>
          <Field label="Keywords" hint='Comma-separated. Matches whole words, plurals and possessives. Use /regex/i for patterns.'>
            <input value={keys} onChange={(ev) => setKeys(ev.target.value)} placeholder="Mira, Mira Vance, the smith" />
          </Field>
          {badRegex.length > 0 && <p className="danger-text small">Invalid regex: {badRegex.join(', ')}</p>}
          <Field label="Content" hint={`~${tokenCount(e.content)} tokens. Supports {{user}} and {{char}}.`}>
            <textarea rows={7} value={e.content} onChange={set('content')} />
          </Field>
          <div className="grid3">
            <Toggle checked={e.constant} onChange={(v) => setE({ ...e, constant: v })} label="Always on" hint="Ignores keywords." />
            <Field label="Priority (order)" hint="Higher wins when the budget is tight."><input type="number" value={e.priority} onChange={set('priority')} /></Field>
            <Field label="Used in">
              <select value={e.modes} onChange={set('modes')}>
                <option value="both">Writing & roleplay</option>
                <option value="writing">Writing only</option>
                <option value="roleplay">Roleplay only</option>
              </select>
            </Field>
          </div>
          <details>
            <summary>Advanced (SillyTavern-compatible)</summary>
            <div className="grid2">
              <Field label="Secondary keywords" hint="Optional filter on top of the keywords.">
                <input value={secondary} onChange={(ev) => setSecondary(ev.target.value)} />
              </Field>
              <Field label="Secondary logic">
                <select value={e.logic} onChange={set('logic')}>{LOGIC.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              <Field label="Insertion position">
                <select value={e.position} onChange={set('position')}>{POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </Field>
              {e.position === 'depth' ? (
                <Field label="Depth" hint="Messages from the end (0 = last)."><input type="number" min={0} value={e.depth} onChange={set('depth')} /></Field>
              ) : <div />}
              <Field label="Trigger chance %" hint="100 = always when matched."><input type="number" min={0} max={100} value={e.probability} onChange={set('probability')} /></Field>
              <Field label="Scan depth" hint="Blank = book/global default."><input type="number" min={0} value={e.scan_depth ?? ''} onChange={(ev) => setE({ ...e, scan_depth: ev.target.value === '' ? null : ev.target.value })} /></Field>
              <Field label="Case-sensitive">
                <select value={e.case_sensitive == null ? '' : e.case_sensitive ? '1' : '0'} onChange={tri('case_sensitive')}><option value="">Default</option><option value="1">Yes</option><option value="0">No</option></select>
              </Field>
              <Field label="Whole words only">
                <select value={e.whole_words == null ? '' : e.whole_words ? '1' : '0'} onChange={tri('whole_words')}><option value="">Default</option><option value="1">Yes</option><option value="0">No</option></select>
              </Field>
            </div>
            <div className="grid3">
              <Field label="Sticky" hint="Stays on this many messages after firing."><input type="number" min={0} value={e.sticky} onChange={set('sticky')} /></Field>
              <Field label="Cooldown" hint="Can't fire again for this many messages."><input type="number" min={0} value={e.cooldown} onChange={set('cooldown')} /></Field>
              <Field label="Delay" hint="Only after the chat has this many messages."><input type="number" min={0} value={e.delay} onChange={set('delay')} /></Field>
            </div>
            <div className="grid3">
              <Field label="Inclusion group" hint="Only one entry per group is used per message."><input value={e.group_name} onChange={set('group_name')} /></Field>
              <Field label="Group weight"><input type="number" min={1} value={e.group_weight} onChange={set('group_weight')} /></Field>
              <Toggle checked={e.group_override} onChange={(v) => setE({ ...e, group_override: v })} label="Prioritize in group" hint="Wins by priority instead of a weighted roll." />
            </div>
            <div className="grid2">
              <Toggle checked={e.exclude_recursion} onChange={(v) => setE({ ...e, exclude_recursion: v })} label="Non-recursable" hint="Only the chat can trigger it, not other entries." />
              <Toggle checked={e.prevent_recursion} onChange={(v) => setE({ ...e, prevent_recursion: v })} label="Prevent further recursion" hint="Its text doesn't trigger other entries." />
              <Toggle checked={e.delay_until_recursion} onChange={(v) => setE({ ...e, delay_until_recursion: v })} label="Delay until recursion" hint="Only other entries can trigger it." />
              <Toggle checked={e.ignore_budget} onChange={(v) => setE({ ...e, ignore_budget: v })} label="Ignore budget" hint="Always fits, even over budget." />
            </div>
          </details>
          <div className="row" style={{ marginTop: 6 }}>
            <AsyncButton className="primary small" disabled={!dirty} notify={notify} onClick={save}>Save</AsyncButton>
            {dirty && <button className="small" onClick={() => { setE(entry); setKeys(entry.keys.join(', ')); setSecondary(entry.secondary_keys.join(', ')); }}>Revert</button>}
            <span className="grow" />
            <AsyncButton className="small danger" notify={notify} onClick={async () => {
              if (!confirm(`Delete "${entry.title}"?`)) return;
              await api.del(`/entries/${entry.id}`);
              onDeleted();
            }}>Delete</AsyncButton>
          </div>
        </div>
      )}
    </div>
  );
}
