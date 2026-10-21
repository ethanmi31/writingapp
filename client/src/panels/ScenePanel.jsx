import { useState } from 'react';
import { api, load, store } from '../api.js';
import { AsyncButton, Dots } from '../components.jsx';

/** The scene simplifier: the essentials of what's going on, in plain words, at a glance. */
export default function ScenePanel({ chat, setChat, notify, tracking, busy, onOption }) {
  const s = chat.scene || {};
  const [size, setSize] = useState(load('sceneSize', 14));
  const changeSize = (d) => {
    const v = Math.max(12, Math.min(20, size + d));
    setSize(v);
    store('sceneSize', v);
  };
  const has = s.happening || s.where;
  const you = s.you || {};
  const lastAi = [...chat.messages].reverse().find((m) => m.role === 'assistant');
  const stale = has && lastAi && s.message_id && s.message_id !== lastAi.id;

  return (
    <div className="scene" style={{ '--scene-size': `${size}px` }}>
      <div className="pane-title">
        <span>💡 Scene simplifier</span>
        <span className="grow" />
        <button className="ghost small" title="Smaller text" onClick={() => changeSize(-1)}>A−</button>
        <button className="ghost small" title="Bigger text" onClick={() => changeSize(1)}>A+</button>
        <AsyncButton className="ghost small" disabled={busy || !lastAi} notify={notify} busyLabel="…" title="Re-read the latest reply" onClick={async () => {
          const r = await api.post(`/chats/${chat.id}/scene/refresh`);
          setChat((c) => ({ ...c, map: r.map || c.map, scene: r.scene || c.scene }));
        }}>↻</AsyncButton>
      </div>
      {tracking && <div className="tiny muted" style={{ marginBottom: 6 }}>Reading the latest reply <Dots /></div>}
      {!has ? (
        <p className="muted small">
          After each narrator reply, this card tells you what's going on in plain words: where you are, who's around, what you're wearing and carrying, what you need to know, and what you could do next.
        </p>
      ) : (
        <>
          {stale && <div className="tiny muted" style={{ marginBottom: 6 }}>From an earlier reply — press ↻ to refresh.</div>}
          {s.happening && <div className="scene-now">{s.happening}</div>}
          <div className="scene-where">
            {s.where && <span className="badge">📍 {s.where}</span>}
            {s.time && <span className="badge">🕰 {s.time}</span>}
            {s.mood && <span className="badge roleplay">{s.mood}</span>}
          </div>
          {s.asked && <div className="scene-asked"><b>Waiting on you:</b> {s.asked}</div>}

          {s.around?.length > 0 && (
            <>
              <h4>Around you</h4>
              <div className="scene-people">
                {s.around.map((a, i) => (
                  <div key={i} className="person">
                    <span>
                      <span className="nm">{a.name}</span>
                      {a.who && <span className="muted"> · {a.who}</span>}
                      {a.doing && <div className="small">{a.doing}</div>}
                    </span>
                    {a.mood && <span className="mood badge">{a.mood}</span>}
                  </div>
                ))}
              </div>
            </>
          )}

          {s.know?.length > 0 && (
            <>
              <h4>Need to know</h4>
              <ul className="know">{s.know.map((k, i) => <li key={i}>{k}</li>)}</ul>
            </>
          )}

          {(you.doing || you.wearing || you.carrying || you.condition) && (
            <>
              <h4>You ({chat.names.user})</h4>
              <dl className="scene-you">
                {you.doing && <><dt>Doing</dt><dd>{you.doing}</dd></>}
                {you.wearing && <><dt>Wearing</dt><dd>{you.wearing}</dd></>}
                {you.carrying && <><dt>Carrying</dt><dd>{you.carrying}</dd></>}
                {you.condition && <><dt>Condition</dt><dd>{you.condition}</dd></>}
              </dl>
            </>
          )}

          {s.options?.length > 0 && (
            <>
              <h4>You could…</h4>
              <div className="scene-options">
                {s.options.map((o, i) => (
                  <button key={i} className="small" disabled={busy} onClick={() => onOption(o)} title="Put this in your message box (edit it before sending)">→ {o}</button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
