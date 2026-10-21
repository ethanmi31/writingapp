import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AsyncButton, Avatar, Field, Modal, ModelInput, Toggle } from '../components.jsx';
import { DOC_MODES } from '../panels/SourcesPanel.jsx';

const TABS = [
  ['general', 'General'],
  ['characters', 'Characters'],
  ['lore', 'Lore & sources'],
  ['sampling', 'Sampling'],
  ['danger', 'More']
];

const SAMPLERS = [
  ['temperature', 'Temperature', 0.05, 'Higher = more surprising word choices.'],
  ['topP', 'Top P', 0.01, '1 = off.'],
  ['minP', 'Min P', 0.01, 'Cuts unlikely tokens; 0.05–0.1 keeps high temperatures coherent. 0 = off.'],
  ['topK', 'Top K', 1, '0 = off.'],
  ['frequencyPenalty', 'Frequency penalty', 0.05, 'Discourages repeating the same words.'],
  ['presencePenalty', 'Presence penalty', 0.05, 'Encourages new topics.'],
  ['repetitionPenalty', 'Repetition penalty', 0.01, '1 = off. 1.05–1.15 for models that loop.']
];

export default function ChatSettings({ chat, models, settings, initialTab = 'general', notify, onClose, onSave, onDelete }) {
  const [tab, setTab] = useState(initialTab);
  const [d, setD] = useState(() => ({
    title: chat.title,
    mode: chat.mode,
    model: chat.model,
    system_prompt: chat.system_prompt,
    author_note: chat.author_note,
    author_note_depth: chat.author_note_depth,
    persona_id: chat.persona_id,
    character_ids: chat.character_ids,
    lorebook_ids: chat.lorebook_ids,
    document_ids: chat.document_ids,
    params: { ...chat.params },
    options: { ...chat.options },
    folder: chat.folder
  }));
  const [chars, setChars] = useState([]);
  const [books, setBooks] = useState([]);
  const [docs, setDocs] = useState([]);
  useEffect(() => {
    api.get('/characters').then(setChars);
    api.get('/lorebooks').then(setBooks);
    api.get('/documents').then(setDocs);
  }, []);

  const rp = d.mode === 'roleplay';
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value });
  const setOpt = (k, v) => setD({ ...d, options: { ...d.options, [k]: v === '' ? undefined : v } });
  const setParam = (k, v) => setD({ ...d, params: { ...d.params, [k]: v === '' ? undefined : Number(v) } });
  const toggleIn = (k, id) => setD({ ...d, [k]: d[k].includes(id) ? d[k].filter((x) => x !== id) : [...d[k], id] });
  const numOpt = (k) => (d.options[k] ?? '');

  const save = async () => {
    const options = Object.fromEntries(Object.entries(d.options).filter(([, v]) => v !== undefined && v !== ''));
    for (const k of ['loreBudget', 'docBudget', 'maxContextTokens', 'manuscriptTokens', 'maxTokens']) if (options[k] != null) options[k] = Number(options[k]);
    await onSave({ ...d, options, params: Object.fromEntries(Object.entries(d.params).filter(([, v]) => v !== undefined && Number.isFinite(v))) });
    notify('Chat settings saved');
    onClose();
  };

  const people = chars.filter((c) => c.kind === 'character');
  const personas = chars.filter((c) => c.kind === 'persona');

  return (
    <Modal
      title="Chat settings"
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" notify={notify} onClick={save}>Save</AsyncButton>
        </>
      }
    >
      <div className="tabs">
        {TABS.map(([id, label]) => <button key={id} className={`chip ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === 'general' && (
        <>
          <div className="grid2">
            <Field label="Title"><input value={d.title} onChange={set('title')} /></Field>
            <Field label="Folder" hint="Group chats in the sidebar (optional)."><input value={d.folder || ''} onChange={set('folder')} placeholder="e.g. Novel: The Ashford Fire" /></Field>
          </div>
          <Field label="Model for this chat" hint={`Blank = the default ${rp ? 'roleplay' : 'writing'} model (${rp ? settings?.roleplayModel : settings?.writingModel}).`}>
            <ModelInput value={d.model} onChange={(v) => setD({ ...d, model: v })} models={models} placeholder={rp ? settings?.roleplayModel : settings?.writingModel} />
          </Field>
          <Field label="System prompt for this chat" hint={`Added after the global ${rp ? 'roleplay' : 'writing'} prompt from Settings. Your project's voice, genre, rules, POV and tense, what to avoid. Supports {{user}} and {{char}}.`}>
            <textarea rows={8} value={d.system_prompt} onChange={set('system_prompt')} placeholder={rp ? 'e.g. Grim, grounded low fantasy. Violence is quick and has consequences. Keep replies under 250 words.' : 'e.g. We are writing a literary thriller. Close third person on Mira, past tense, British spelling. Sparse, cold prose like Le Carré.'} />
          </Field>
          <div className="grid2">
            <Field label="Author's note" hint="A short reminder inserted near the end of the context, so it carries more weight. Great for the current tone or goal.">
              <textarea rows={3} value={d.author_note} onChange={set('author_note')} placeholder="e.g. [Mira is exhausted and short-tempered. Build dread slowly.]" />
            </Field>
            <Field label="Author's note depth" hint="How many messages from the end it goes (0 = right at the end).">
              <input type="number" min={0} value={d.author_note_depth} onChange={set('author_note_depth')} />
            </Field>
          </div>
          <Field label="Mode" hint="Switching keeps your messages. Roleplay adds the map and scene simplifier; writing adds the manuscript.">
            <select value={d.mode} onChange={set('mode')}>
              <option value="writing">✍️ Writing</option>
              <option value="roleplay">⚔️ Roleplay</option>
            </select>
          </Field>
        </>
      )}

      {tab === 'characters' && (
        <>
          <h3 style={{ marginTop: 0 }}>{rp ? 'Characters the narrator plays' : 'Character profiles (optional)'}</h3>
          <p className="hint">{rp ? 'Their cards are always in context. Order matters: the first one\'s greeting opens a new chat and is {{char}}.' : 'Profiles sent with every message — handy for a main cast. For big casts, lorebooks are cheaper (only loaded when mentioned).'}</p>
          <div className="pick-list">
            {people.map((c) => (
              <label key={c.id} className={`pick ${d.character_ids.includes(c.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={d.character_ids.includes(c.id)} onChange={() => toggleIn('character_ids', c.id)} />
                <Avatar c={c} size={26} />
                <span className="grow">{c.name}</span>
                <span className="tiny muted">~{c.tokens} tok</span>
              </label>
            ))}
            {!people.length && <span className="muted small" style={{ padding: 8 }}>No characters yet — create or import cards under Characters.</span>}
          </div>
          {rp && (
            <>
              <h3>Who you play (persona)</h3>
              <div className="pick-list">
                <label className={`pick ${!d.persona_id ? 'on' : ''}`}>
                  <input type="radio" checked={!d.persona_id} onChange={() => setD({ ...d, persona_id: null })} />
                  <span>Nobody in particular ("User")</span>
                </label>
                {personas.map((c) => (
                  <label key={c.id} className={`pick ${d.persona_id === c.id ? 'on' : ''}`}>
                    <input type="radio" checked={d.persona_id === c.id} onChange={() => setD({ ...d, persona_id: c.id })} />
                    <Avatar c={c} size={26} />
                    <span className="grow">{c.name}</span>
                  </label>
                ))}
              </div>
              <p className="hint">Make personas under Characters → Personas. The narrator never writes for your persona.</p>
            </>
          )}
        </>
      )}

      {tab === 'lore' && (
        <>
          <h3 style={{ marginTop: 0 }}>Lorebooks</h3>
          <div className="pick-list">
            {books.filter((b) => !b.character_id).map((b) => (
              <label key={b.id} className={`pick ${d.lorebook_ids.includes(b.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={d.lorebook_ids.includes(b.id)} onChange={() => toggleIn('lorebook_ids', b.id)} />
                <span className="grow">{b.name}</span>
                <span className="tiny muted">{b.entryCount} entries</span>
              </label>
            ))}
            {!books.length && <span className="muted small" style={{ padding: 8 }}>No lorebooks yet.</span>}
          </div>
          <h3>Documents</h3>
          <div className="pick-list">
            {docs.map((x) => (
              <label key={x.id} className={`pick ${d.document_ids.includes(x.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={d.document_ids.includes(x.id)} onChange={() => toggleIn('document_ids', x.id)} />
                <span className="grow ellipsis">{x.name}</span>
                <span className="tiny muted">{x.tokens.toLocaleString()} tok</span>
              </label>
            ))}
            {!docs.length && <span className="muted small" style={{ padding: 8 }}>No documents yet.</span>}
          </div>
          <h3>Budgets for this chat</h3>
          <p className="hint">Blank = the app defaults from Settings.</p>
          <div className="grid2">
            <Field label="Document lookup">
              <select value={d.options.docMode ?? ''} onChange={(e) => setOpt('docMode', e.target.value)}>
                <option value="">Default ({settings?.docMode})</option>
                {DOC_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Lore budget (tokens)"><input type="number" value={numOpt('loreBudget')} placeholder={settings?.loreBudget} onChange={(e) => setOpt('loreBudget', e.target.value)} /></Field>
            <Field label="Document excerpts budget (tokens)"><input type="number" value={numOpt('docBudget')} placeholder={settings?.docBudget} onChange={(e) => setOpt('docBudget', e.target.value)} /></Field>
            <Field label="Total context target (tokens)" hint="History fills whatever is left."><input type="number" value={numOpt('maxContextTokens')} placeholder={settings?.maxContextTokens} onChange={(e) => setOpt('maxContextTokens', e.target.value)} /></Field>
            {!rp && <Field label="Manuscript in context (tokens)"><input type="number" value={numOpt('manuscriptTokens')} placeholder={settings?.manuscriptTokens} onChange={(e) => setOpt('manuscriptTokens', e.target.value)} /></Field>}
          </div>
          {rp && (
            <>
              <h3>World tracking</h3>
              <Toggle checked={d.options.trackerEnabled ?? settings?.trackerEnabled} onChange={(v) => setOpt('trackerEnabled', v)} label="Map keeper" hint="Updates the map after every narrator reply (one cheap utility-model call)." />
              <Toggle checked={d.options.simplifierEnabled ?? settings?.simplifierEnabled} onChange={(v) => setOpt('simplifierEnabled', v)} label="Scene simplifier" hint="Writes the plain-words scene card after every reply (one cheap call)." />
            </>
          )}
        </>
      )}

      {tab === 'sampling' && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>Overrides for this chat only. Blank = Settings defaults. Not every model supports every sampler; unsupported ones are ignored by OpenRouter.</p>
          <div className="grid2">
            <Field label="Max reply length (tokens)" hint="~750 words per 1000 tokens.">
              <input type="number" value={d.options.maxTokens ?? ''} placeholder={rp ? settings?.roleplayMaxTokens : settings?.writingMaxTokens} onChange={(e) => setOpt('maxTokens', e.target.value)} />
            </Field>
            {SAMPLERS.map(([k, label, step, hint]) => (
              <Field key={k} label={label} hint={hint}>
                <input type="number" step={step} value={d.params[k] ?? ''} placeholder={settings?.[k]} onChange={(e) => setParam(k, e.target.value)} />
              </Field>
            ))}
          </div>
        </>
      )}

      {tab === 'danger' && (
        <>
          <div className="row wrap">
            <a className="button" href={`/api/chats/${chat.id}/export?format=md`}>⤓ Export as Markdown</a>
            <a className="button" href={`/api/chats/${chat.id}/export`}>⤓ Export as JSON</a>
            {!rp && <a className="button" href={`/api/chats/${chat.id}/export?format=manuscript`}>⤓ Manuscript</a>}
          </div>
          <hr />
          <AsyncButton className="danger" notify={notify} onClick={onDelete}>Delete this chat</AsyncButton>
        </>
      )}
    </Modal>
  );
}
