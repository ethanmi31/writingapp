import { useEffect, useState } from 'react';
import { api, upload } from '../api.js';
import { AsyncButton, Field, ModelInput, Toggle, pickFiles } from '../components.jsx';
import { DOC_MODES } from '../panels/SourcesPanel.jsx';

const num = (label, k, step, hint) => ({ label, k, step, hint });
const LENGTHS = [
  num('Total context target (tokens)', 'maxContextTokens', 1000, 'How big each prompt may get. History fills what\'s left after the system prompt, lore and documents. Bigger = more memory, more cost.'),
  num('Writing reply length (tokens)', 'writingMaxTokens', 100, '~750 words per 1000 tokens.'),
  num('Roleplay reply length (tokens)', 'roleplayMaxTokens', 50, ''),
  num('Manuscript in context (tokens)', 'manuscriptTokens', 250, 'How much of the end of your manuscript the AI sees in writing mode.')
];
const SAMPLING = [
  num('Temperature', 'temperature', 0.05, 'Higher = more creative, lower = more predictable.'),
  num('Top P', 'topP', 0.01, '1 = off.'),
  num('Min P', 'minP', 0.01, '0.05–0.1 keeps high temperatures coherent. 0 = off.'),
  num('Top K', 'topK', 1, '0 = off.'),
  num('Frequency penalty', 'frequencyPenalty', 0.05, ''),
  num('Presence penalty', 'presencePenalty', 0.05, ''),
  num('Repetition penalty', 'repetitionPenalty', 0.01, '1 = off.')
];
const LORE = [
  num('Lore budget (tokens)', 'loreBudget', 100, 'Max lorebook tokens per message.'),
  num('Scan depth (messages)', 'scanDepth', 1, 'How many recent messages are scanned for keywords.'),
  num('Recursion steps', 'recursionSteps', 1, 'How many times activated entries can trigger further entries. 0 = off.'),
  num('Document excerpts budget (tokens)', 'docBudget', 100, 'Max tokens of looked-up document passages per message.'),
  num('Compile chunk size (tokens)', 'compileChunkTokens', 250, 'Document chunk size when compiling into a lorebook.')
];

export default function Settings({ settings, models, notify, onSaved }) {
  const [s, setS] = useState(null);
  useEffect(() => { if (settings) setS({ ...settings, apiKey: '' }); }, [settings]);
  if (!s) return null;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  const numField = ({ label, k, step, hint }) => (
    <Field key={k} label={label} hint={hint}>
      <input type="number" step={step} min={0} value={s[k]} onChange={set(k)} />
    </Field>
  );
  const save = async () => {
    await api.put('/settings', s);
    notify('Settings saved');
    onSaved();
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Settings</h1>
        <AsyncButton className="primary" notify={notify} onClick={save}>Save settings</AsyncButton>
      </header>

      <section className="card">
        <h2>OpenRouter</h2>
        <Field label="API key" hint="Stored only on this computer (data/inkwell.db). Get one at openrouter.ai/keys. Or set OPENROUTER_API_KEY.">
          <input type="password" value={s.apiKey} onChange={set('apiKey')} placeholder={settings.hasApiKey ? `Saved (${settings.apiKeyHint}) — leave blank to keep` : 'sk-or-…'} autoComplete="off" />
        </Field>
        <p className="hint">
          Inkwell adds no filters of its own. How uncensored a reply is depends on the model and provider you pick — open-weight models (DeepSeek, Llama, Mistral, Qwen, Hermes…) are the most permissive.
          Some providers moderate certain models on their side.
        </p>
        <div className="grid2">
          <Field label="Writing model" hint="Default for writing chats (each chat can override)."><ModelInput value={s.writingModel} onChange={(v) => setS({ ...s, writingModel: v })} models={models} /></Field>
          <Field label="Roleplay model" hint="Default narrator for roleplay chats."><ModelInput value={s.roleplayModel} onChange={(v) => setS({ ...s, roleplayModel: v })} models={models} /></Field>
          <Field label="Utility model" hint="Cheap & fast: summaries, document lookups, lore compiling, lore keeper."><ModelInput value={s.utilityModel} onChange={(v) => setS({ ...s, utilityModel: v })} models={models} /></Field>
          <Field label="Map keeper model" hint="Blank = utility model. Needs to be good at JSON."><ModelInput value={s.trackerModel} onChange={(v) => setS({ ...s, trackerModel: v })} models={models} placeholder={s.utilityModel} /></Field>
          <Field label="Scene simplifier model" hint="Blank = utility model."><ModelInput value={s.simplifierModel} onChange={(v) => setS({ ...s, simplifierModel: v })} models={models} placeholder={s.utilityModel} /></Field>
          <Field label="Daily spending limit (USD)" hint="All AI calls stop once today's spend reaches this. 0 = no limit.">
            <input type="number" min={0} step={0.1} value={s.dailySpendLimit} onChange={set('dailySpendLimit')} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Length & memory</h2>
        <div className="grid2">{LENGTHS.map(numField)}</div>
        <Toggle checked={s.showReasoning} onChange={(v) => setS({ ...s, showReasoning: v })} label="Keep reasoning from thinking models" hint="Shown collapsed above the reply; never sent back to the model." />
      </section>

      <section className="card">
        <h2>Sampling defaults</h2>
        <div className="grid3">{SAMPLING.map(numField)}</div>
      </section>

      <section className="card">
        <h2>Lorebooks & documents</h2>
        <div className="grid3">{LORE.map(numField)}</div>
        <div className="grid3">
          <Toggle checked={s.matchInflections} onChange={(v) => setS({ ...s, matchInflections: v })} label="Match plurals & possessives" hint={'"dragon" also fires on "dragons", "Kael" on "Kael\'s".'} />
          <Toggle checked={s.wholeWords} onChange={(v) => setS({ ...s, wholeWords: v })} label="Whole words only" hint={'"art" won\'t fire on "start".'} />
          <Toggle checked={s.caseSensitive} onChange={(v) => setS({ ...s, caseSensitive: v })} label="Case-sensitive keys" />
        </div>
        <Field label="Document lookup (default for chats)" hint="Smart: a cheap AI call decides what the loaded lore is missing and searches only for that. Free: looks up names and terms that no loaded entry covers.">
          <select value={s.docMode} onChange={set('docMode')}>{DOC_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
      </section>

      <section className="card">
        <h2>Roleplay world tracking</h2>
        <Toggle checked={s.trackerEnabled} onChange={(v) => setS({ ...s, trackerEnabled: v })} label="Map keeper" hint="After each narrator reply, updates the map: places, connections, where everyone is, outfits, items." />
        <Toggle checked={s.simplifierEnabled} onChange={(v) => setS({ ...s, simplifierEnabled: v })} label="Scene simplifier" hint="After each reply, writes the plain-words scene card and a one-line summary under the message." />
      </section>

      <section className="card">
        <h2>System prompts</h2>
        <p className="hint">The base instructions for every chat of each mode (each chat adds its own). Supports {'{{user}}'} and {'{{char}}'}.</p>
        <Field label="Writing">
          <textarea rows={10} value={s.writingSystemPrompt} onChange={set('writingSystemPrompt')} />
        </Field>
        <button className="link small" onClick={() => setS({ ...s, writingSystemPrompt: settings.defaults.writingSystemPrompt })}>Reset writing prompt</button>
        <Field label="Roleplay">
          <textarea rows={10} value={s.roleplaySystemPrompt} onChange={set('roleplaySystemPrompt')} />
        </Field>
        <button className="link small" onClick={() => setS({ ...s, roleplaySystemPrompt: settings.defaults.roleplaySystemPrompt })}>Reset roleplay prompt</button>
      </section>

      <section className="card">
        <h2>Writing quick prompts</h2>
        <p className="hint">One-click buttons above the message box in writing chats.</p>
        {(s.writingQuickPrompts || []).map((q, i) => (
          <div key={i} className="row top" style={{ marginBottom: 6 }}>
            <input style={{ width: 150 }} value={q.label} onChange={(e) => setS({ ...s, writingQuickPrompts: s.writingQuickPrompts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <textarea rows={2} value={q.text} onChange={(e) => setS({ ...s, writingQuickPrompts: s.writingQuickPrompts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
            <button className="icon ghost" onClick={() => setS({ ...s, writingQuickPrompts: s.writingQuickPrompts.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <div className="row">
          <button className="small" onClick={() => setS({ ...s, writingQuickPrompts: [...(s.writingQuickPrompts || []), { label: 'New', text: '' }] })}>＋ Add</button>
          <button className="link small" onClick={() => setS({ ...s, writingQuickPrompts: settings.defaults.writingQuickPrompts })}>Reset</button>
        </div>
      </section>

      <section className="card">
        <h2>Output rules</h2>
        <p className="hint">Find & replace (regular expressions) applied to every AI reply — e.g. strip phrases a model overuses, or fix formatting.</p>
        {(s.regexRules || []).map((r, i) => {
          const upd = (patch) => setS({ ...s, regexRules: s.regexRules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          let bad = false;
          try { new RegExp(r.find || '', (r.flags || 'g').replace(/[^gimsuy]/g, '')); } catch { bad = true; }
          return (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={!!r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
              <input className={`mono ${bad ? 'danger-text' : ''}`} placeholder="find (regex)" value={r.find} onChange={(e) => upd({ find: e.target.value })} />
              <input className="mono" placeholder="replace with" value={r.replace} onChange={(e) => upd({ replace: e.target.value })} />
              <input className="mono" style={{ width: 60 }} placeholder="flags" value={r.flags ?? 'g'} onChange={(e) => upd({ flags: e.target.value })} />
              <button className="icon ghost" onClick={() => setS({ ...s, regexRules: s.regexRules.filter((_, j) => j !== i) })}>✕</button>
            </div>
          );
        })}
        <button className="small" onClick={() => setS({ ...s, regexRules: [...(s.regexRules || []), { find: '', replace: '', flags: 'gi', enabled: true }] })}>＋ Add rule</button>
      </section>

      <section className="card">
        <h2>Backup</h2>
        <p className="hint">One file with all chats, lorebooks, characters, documents and maps (not your API key). Restoring adds copies; it never overwrites.</p>
        <div className="row">
          <a className="button" href="/api/backup">⤓ Download backup</a>
          <AsyncButton notify={notify} onClick={async () => {
            const [f] = await pickFiles({ accept: '.json', multiple: false });
            if (!f) return;
            const r = await upload('/backup', [f], 'file');
            notify(`Restored ${r.chats} chats, ${r.lorebooks} lorebooks, ${r.characters} characters, ${r.documents} documents. Reload to see them.`);
          }}>⤒ Restore from backup</AsyncButton>
        </div>
      </section>

      <div className="row" style={{ marginBottom: 40 }}>
        <AsyncButton className="primary" notify={notify} onClick={save}>Save settings</AsyncButton>
      </div>
    </div>
  );
}
