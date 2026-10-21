import { useEffect, useState } from 'react';
import { api, upload, tokens as tokenCount } from '../api.js';
import { AsyncButton, Avatar, Field, Modal, Empty, pickFiles } from '../components.jsx';

export default function Characters({ notify, onStart }) {
  const [list, setList] = useState([]);
  const [kind, setKind] = useState('character');
  const [editing, setEditing] = useState(null);
  const refresh = () => api.get('/characters').then(setList);
  useEffect(() => { refresh(); }, []);
  const shown = list.filter((c) => c.kind === kind);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <header className="page-head">
        <div>
          <h1>Characters</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Character cards the AI plays, and personas you play. Imports SillyTavern / Chub V1–V3 cards (.png or .json), including their embedded lorebooks.</p>
        </div>
        <div className="row">
          <AsyncButton notify={notify} onClick={async () => {
            const files = await pickFiles({ accept: '.png,.json' });
            if (!files.length) return;
            const r = await upload(`/characters/import${kind === 'persona' ? '?kind=persona' : ''}`, files);
            const ok = r.filter((x) => !x.error);
            notify(`Imported ${ok.map((x) => `${x.name}${x.loreEntries ? ` (+${x.loreEntries} lore)` : ''}`).join(', ') || 'nothing'}${r.some((x) => x.error) ? ` · ${r.filter((x) => x.error).map((x) => `${x.file}: ${x.error}`).join(' ')}` : ''}`, r.some((x) => x.error) ? 'error' : 'info');
            refresh();
          }}>⤒ Import cards</AsyncButton>
          <AsyncButton className="primary" notify={notify} onClick={async () => {
            const c = await api.post('/characters', { kind, name: kind === 'persona' ? 'Me' : 'New character' });
            await refresh();
            setEditing(c.id);
          }}>＋ New {kind}</AsyncButton>
        </div>
      </header>
      <div className="tabs">
        <button className={`chip ${kind === 'character' ? 'active' : ''}`} onClick={() => setKind('character')}>🎭 Characters ({list.filter((c) => c.kind === 'character').length})</button>
        <button className={`chip ${kind === 'persona' ? 'active' : ''}`} onClick={() => setKind('persona')}>🙂 Personas — who you play ({list.filter((c) => c.kind === 'persona').length})</button>
      </div>
      {!shown.length ? (
        <Empty icon={kind === 'persona' ? '🙂' : '🎭'} title={kind === 'persona' ? 'No personas yet' : 'No characters yet'}>
          {kind === 'persona' ? 'A persona is your character in roleplay: name, looks, personality, background. The narrator never writes for them.' : 'Create a character or import a card.'}
        </Empty>
      ) : (
        <div className="char-grid">
          {shown.map((c) => (
            <div key={c.id} className="char-card" onClick={() => setEditing(c.id)}>
              <div className="row">
                <Avatar c={c} size={44} />
                <div className="grow">
                  <div className="bold ellipsis">{c.name}</div>
                  <div className="tiny muted">~{c.tokens} tokens{c.lorebook_id ? ' · has lorebook' : ''}</div>
                </div>
              </div>
              <div className="desc">{c.description || <i>No description</i>}</div>
              {kind === 'character' && <button className="small" onClick={(e) => { e.stopPropagation(); onStart(c); }}>⚔️ Roleplay</button>}
            </div>
          ))}
        </div>
      )}
      {editing && <Editor id={editing} notify={notify} onClose={() => { setEditing(null); refresh(); }} />}
    </div>
  );
}

function Editor({ id, notify, onClose }) {
  const [c, setC] = useState(null);
  useEffect(() => { api.get(`/characters/${id}`).then(setC); }, [id]);
  if (!c) return null;
  const persona = c.kind === 'persona';
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    await api.put(`/characters/${id}`, c);
    notify('Saved');
    onClose();
  };
  const field = (k, label, rows, hint, placeholder) => (
    <Field label={label} hint={hint}>
      <textarea rows={rows} value={c[k] || ''} onChange={set(k)} placeholder={placeholder} />
    </Field>
  );

  return (
    <Modal title={persona ? 'Persona' : 'Character'} wide onClose={onClose} footer={
      <>
        <AsyncButton className="danger" notify={notify} onClick={async () => {
          if (!confirm(`Delete ${c.name}?`)) return;
          await api.del(`/characters/${id}`);
          onClose();
        }}>Delete</AsyncButton>
        <span className="grow" />
        <a className="button" href={`/api/characters/${id}/export`}>⤓ Export card</a>
        <button onClick={onClose}>Cancel</button>
        <AsyncButton className="primary" notify={notify} onClick={save}>Save</AsyncButton>
      </>
    }>
      <div className="row top" style={{ gap: 16 }}>
        <div className="col" style={{ alignItems: 'center' }}>
          <Avatar c={c} size={96} />
          <AsyncButton className="small" notify={notify} onClick={async () => {
            const [f] = await pickFiles({ accept: 'image/*', multiple: false });
            if (!f) return;
            const r = await upload(`/characters/${id}/avatar`, [f], 'file');
            setC({ ...c, avatar: r.avatar });
          }}>Picture</AsyncButton>
          {c.avatar && <button className="small ghost" onClick={async () => { await api.del(`/characters/${id}/avatar`); setC({ ...c, avatar: '' }); }}>Remove</button>}
        </div>
        <div className="grow">
          <div className="grid2">
            <Field label="Name"><input value={c.name} onChange={set('name')} /></Field>
            <Field label="Colour"><input type="color" value={c.color || '#8b7bff'} onChange={set('color')} style={{ height: 38, padding: 4 }} /></Field>
          </div>
          {field('description', persona ? 'Who you are' : 'Description', 8, `Appearance, personality, background, how they talk. ~${tokenCount([c.description, c.personality, c.scenario, c.example_dialogue].join(' '))} tokens with the fields below. {{user}} / {{char}} work.`, persona ? 'Name, age, looks, what you usually wear, personality, skills, background…' : '')}
        </div>
      </div>
      {!persona && (
        <>
          {field('personality', 'Personality summary', 2)}
          {field('scenario', 'Scenario', 3, 'The situation the story starts in.')}
          {field('first_message', 'First message (greeting)', 5, 'Opens a new roleplay with this character.')}
          <Field label="Alternate greetings" hint="Each becomes a swipe of the first message. Separate with a line containing only ---">
            <textarea rows={4} value={(c.alt_greetings || []).join('\n---\n')} onChange={(e) => setC({ ...c, alt_greetings: e.target.value.split(/\n-{3,}\n/) })} />
          </Field>
          {field('example_dialogue', 'Example dialogue', 5, 'How they talk. Separate examples with <START>.')}
          <details>
            <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent-2)' }}>Card prompt overrides & notes</summary>
            {field('system_prompt', 'Character system prompt', 3, 'Added to the system prompt when this character is in a chat.')}
            {field('post_history', 'Post-history instructions', 3, 'Sent after the chat history (strong influence).')}
            {field('creator_notes', 'Creator notes', 3, 'Not sent to the AI.')}
          </details>
          <div className="row" style={{ marginTop: 10 }}>
            {c.lorebook_id ? <span className="small muted">📚 This character has its own lorebook (edit it under Lorebooks). It's used automatically wherever they appear and exported with the card.</span> : (
              <AsyncButton className="small" notify={notify} onClick={async () => {
                const r = await api.post(`/characters/${id}/lorebook`);
                setC({ ...c, lorebook_id: r.id });
                notify('Created — add entries under Lorebooks.');
              }}>＋ Give them their own lorebook</AsyncButton>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
