import { useEffect, useRef, useState } from 'react';

export function Avatar({ c, size = 36 }) {
  const name = c?.name || '?';
  if (c?.avatar) return <img className="avatar" src={`/avatars/${c.avatar}`} alt={name} style={{ width: size, height: size }} />;
  const initials = name.split(/\s+/).map((w) => [...w][0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, background: c?.color || '#6b6f80', fontSize: size * 0.4 }}>
      {initials}
    </div>
  );
}

/** Button that shows a busy state while its async onClick runs, and reports errors. */
export function AsyncButton({ onClick, children, notify, busyLabel, ...rest }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      onClick={async (e) => {
        setBusy(true);
        try { await onClick(e); } catch (err) { notify ? notify(err.message, 'error') : alert(err.message); } finally { setBusy(false); }
      }}
    >
      {busy ? busyLabel || 'Working…' : children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="toggle">
      <span className="switch">
        <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      <span>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Textarea that saves itself a moment after you stop typing (and when it loses focus). */
export function AutoSaveText({ value, onSave, delay = 700, ...rest }) {
  const [text, setText] = useState(value ?? '');
  const [state, setState] = useState('saved');
  const timer = useRef(null);
  const latest = useRef(value ?? '');
  useEffect(() => {
    // outside changes (e.g. "append to manuscript") replace the text unless the user is mid-edit
    if (state === 'saved' && value !== latest.current) { setText(value ?? ''); latest.current = value ?? ''; }
  }, [value]);
  const flush = async (t) => {
    clearTimeout(timer.current);
    if (t === latest.current) return setState('saved');
    setState('saving');
    try {
      await onSave(t);
      latest.current = t;
      setState('saved');
    } catch {
      setState('error');
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <textarea
        {...rest}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState('dirty');
          clearTimeout(timer.current);
          const t = e.target.value;
          timer.current = setTimeout(() => flush(t), delay);
        }}
        onBlur={() => flush(text)}
      />
      <span className={`save-state ${state}`}>{{ saved: 'Saved', dirty: 'Editing…', saving: 'Saving…', error: 'Not saved — retrying when you type' }[state]}</span>
    </>
  );
}

export const timeAgo = (iso) => {
  if (!iso) return '';
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// --- message formatting: *actions*, **bold**, "dialogue", `code`, # headings, > quotes, --- breaks -------
const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|"[^"\n]+"|“[^”\n]+”|`[^`\n]+`)/g;

function inline(text, key) {
  return String(text)
    .split(INLINE)
    .map((part, i) => {
      if (!part) return null;
      const k = `${key}-${i}`;
      if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^\*[^*]+\*$/.test(part) || /^_[^_]+_$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
      if (/^["“].*["”]$/.test(part)) return <q key={k} className="dlg">{part.slice(1, -1)}</q>;
      if (/^`.*`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      return part;
    });
}

export function Prose({ text, className = '' }) {
  const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return (
    <div className={`prose ${className}`}>
      {blocks.map((b, i) => {
        const t = b.trim();
        if (!t) return null;
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return <hr key={i} />;
        const h = t.match(/^(#{1,4})\s+(.*)$/);
        if (h && !t.includes('\n')) return <div key={i} className={`h h${h[1].length}`}>{inline(h[2], i)}</div>;
        if (t.split('\n').every((l) => /^>\s?/.test(l))) return <blockquote key={i}>{inline(t.replace(/^>\s?/gm, ''), i)}</blockquote>;
        if (t.split('\n').every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          return <ul key={i}>{t.split('\n').map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''), `${i}-${j}`)}</li>)}</ul>;
        }
        const lines = t.split('\n');
        return <p key={i}>{lines.map((l, j) => <span key={j}>{inline(l, `${i}-${j}`)}{j < lines.length - 1 && <br />}</span>)}</p>;
      })}
    </div>
  );
}

export function Dots() {
  return <span className="dots"><i /><i /><i /></span>;
}

export function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}

/** Model picker with OpenRouter's catalogue, prices and context sizes. */
export function ModelInput({ value, onChange, models, placeholder }) {
  const m = models.find((x) => x.id === value);
  const perM = (p) => (p * 1e6).toFixed(p * 1e6 < 1 ? 3 : 2);
  return (
    <>
      <input list="or-models" value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <span className="hint">
        {m ? <>${perM(m.prompt)} in / ${perM(m.completion)} out per 1M tokens · {Math.round((m.context || 0) / 1000)}k context</> : value && models.length ? <span className="danger-text">Not found on OpenRouter</span> : null}
      </span>
    </>
  );
}

export function ModelList({ models }) {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  return (
    <datalist id="or-models">
      {sorted.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </datalist>
  );
}

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Opens a file picker and resolves with the chosen files. */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}
