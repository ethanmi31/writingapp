import { useEffect, useState } from 'react';
import { api, upload } from '../api.js';
import { AsyncButton, Avatar, Field, Modal, pickFiles } from '../components.jsx';

export default function NewChat({ initial, notify, onClose, onCreated }) {
  const [mode, setMode] = useState(initial.mode || 'writing');
  const [title, setTitle] = useState('');
  const [characterIds, setCharacterIds] = useState(initial.characterIds || []);
  const [personaId, setPersonaId] = useState(null);
  const [lorebookIds, setLorebookIds] = useState([]);
  const [documentIds, setDocumentIds] = useState([]);
  const [notes, setNotes] = useState('');
  const [chars, setChars] = useState([]);
  const [books, setBooks] = useState([]);
  const [docs, setDocs] = useState([]);

  const loadDocs = () => api.get('/documents').then(setDocs);
  useEffect(() => {
    api.get('/characters').then((c) => {
      setChars(c);
      const personas = c.filter((x) => x.kind === 'persona');
      if (personas.length === 1) setPersonaId(personas[0].id);
    });
    api.get('/lorebooks').then(setBooks);
    loadDocs();
  }, []);
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const rp = mode === 'roleplay';
  const people = chars.filter((c) => c.kind === 'character');
  const personas = chars.filter((c) => c.kind === 'persona');

  const create = async () => {
    const chat = await api.post('/chats', { mode, title, characterIds, personaId, lorebookIds, documentIds, notes });
    onCreated(chat);
  };

  return (
    <Modal title="New chat" wide onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><AsyncButton className="primary" notify={notify} onClick={create}>Create</AsyncButton></>}>
      <div className="mode-cards">
        <div className={`mode-card writing ${mode === 'writing' ? 'on' : ''}`} onClick={() => setMode('writing')}>
          <div className="big">✍️</div>
          <div className="t">Writing</div>
          <div className="d">Draft with an AI partner: brainstorm, outline, write and rewrite. Manuscript and notes panels; lore and documents looked up as needed.</div>
        </div>
        <div className={`mode-card roleplay ${mode === 'roleplay' ? 'on' : ''}`} onClick={() => setMode('roleplay')}>
          <div className="big">⚔️</div>
          <div className="t">Roleplay</div>
          <div className="d">Play a character in a living world. A narrator voices everyone else; a live map and a plain-words scene card keep you oriented.</div>
        </div>
      </div>
      <div className="grid2">
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={rp ? 'New roleplay' : 'Untitled draft'} autoFocus /></Field>
        {rp && (
          <Field label="You play">
            <select value={personaId || ''} onChange={(e) => setPersonaId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Nobody in particular</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label={rp ? 'Scenario / premise' : 'What are you writing? (story notes — you can change this anytime)'}>
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={rp ? 'Where and how does the story start? What should stay true?' : 'Genre, premise, POV and tense, the outline so far…'} />
      </Field>
      <div className="grid2">
        <div>
          <h3>{rp ? 'Characters' : 'Character profiles'}</h3>
          <div className="pick-list">
            {people.map((c) => (
              <label key={c.id} className={`pick ${characterIds.includes(c.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={characterIds.includes(c.id)} onChange={() => toggle(characterIds, setCharacterIds, c.id)} />
                <Avatar c={c} size={24} />
                <span className="grow">{c.name}</span>
              </label>
            ))}
            {!people.length && <span className="muted small" style={{ padding: 8 }}>{rp ? 'No cards yet — the narrator can run the world on its own, or import cards under Characters.' : 'None yet (optional).'}</span>}
          </div>
        </div>
        <div>
          <h3>Lorebooks</h3>
          <div className="pick-list">
            {books.filter((b) => !b.character_id).map((b) => (
              <label key={b.id} className={`pick ${lorebookIds.includes(b.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={lorebookIds.includes(b.id)} onChange={() => toggle(lorebookIds, setLorebookIds, b.id)} />
                <span className="grow">{b.name}</span>
                <span className="tiny muted">{b.entryCount}</span>
              </label>
            ))}
            {!books.filter((b) => !b.character_id).length && <span className="muted small" style={{ padding: 8 }}>None yet (optional).</span>}
          </div>
        </div>
      </div>
      <h3>Source documents</h3>
      <div className="pick-list">
        {docs.map((x) => (
          <label key={x.id} className={`pick ${documentIds.includes(x.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={documentIds.includes(x.id)} onChange={() => toggle(documentIds, setDocumentIds, x.id)} />
            <span className="grow ellipsis">{x.name}</span>
            <span className="tiny muted">{x.tokens.toLocaleString()} tokens</span>
          </label>
        ))}
        {!docs.length && <span className="muted small" style={{ padding: 8 }}>None yet (optional). Books, wikis and notes of any size work.</span>}
      </div>
      <AsyncButton className="small" style={{ marginTop: 8 }} notify={notify} busyLabel="Uploading…" onClick={async () => {
        const files = await pickFiles({ accept: '.txt,.md,.markdown,.docx,.pdf,.html,.htm' });
        if (!files.length) return;
        const added = await upload('/documents', files);
        await loadDocs();
        setDocumentIds((ids) => [...ids, ...added.map((d) => d.id)]);
      }}>⤒ Upload a document</AsyncButton>
    </Modal>
  );
}
