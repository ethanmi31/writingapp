import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamPost, load, store, wordCount, tokens as tokenCount } from '../api.js';
import { AsyncButton, AutoSaveText, Dots, Prose, download } from '../components.jsx';
import ChatSettings from './ChatSettings.jsx';
import MapPanel from '../panels/MapPanel.jsx';
import ScenePanel from '../panels/ScenePanel.jsx';
import SourcesPanel from '../panels/SourcesPanel.jsx';
import ContextPanel from '../panels/ContextPanel.jsx';

const TABS = {
  writing: [
    ['manuscript', '📜 Manuscript'],
    ['notes', '🗒 Notes'],
    ['sources', '📚 Sources'],
    ['context', '🔍 Context']
  ],
  roleplay: [
    ['scene', '🗺 Map & Scene'],
    ['notes', '🗒 Scenario'],
    ['sources', '📚 Sources'],
    ['context', '🔍 Context']
  ]
};

export default function ChatView({ chatId, settings, models, notify, onChanged, onOpenChat, onMenu, onDeleted }) {
  const [chat, setChat] = useState(null);
  const [live, setLive] = useState(null); // the reply being streamed
  const [tracking, setTracking] = useState(false);
  const [draft, setDraft] = useState(load(`draft:${chatId}`, ''));
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);
  const [ooc, setOoc] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showSettings, setShowSettings] = useState(null);
  const [tab, setTab] = useState(null);
  const [panelOpen, setPanelOpen] = useState(load('panelOpen', window.innerWidth > 1100));
  const [panelWidth, setPanelWidth] = useState(load('panelWidth', 460));
  const [inspect, setInspect] = useState(null); // message id shown in the Context tab
  const [showTldr, setShowTldr] = useState(load('showTldr', true));
  const scroller = useRef(null);
  const stick = useRef(true);
  const inputRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setChat(await api.get(`/chats/${chatId}`));
    } catch (e) {
      notify(e.message, 'error');
      onDeleted();
    }
  }, [chatId]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => store(`draft:${chatId}`, draft), [draft]);
  useEffect(() => store('panelOpen', panelOpen), [panelOpen]);
  useEffect(() => store('panelWidth', panelWidth), [panelWidth]);
  useEffect(() => store('showTldr', showTldr), [showTldr]);
  useEffect(() => {
    if (!chat || TABS[chat.mode].some(([id]) => id === tab)) return;
    const saved = load(`tab:${chat.mode}`, null);
    setTab(TABS[chat.mode].some(([id]) => id === saved) ? saved : TABS[chat.mode][0][0]);
  }, [chat?.mode]);
  useEffect(() => { if (tab && chat) store(`tab:${chat.mode}`, tab); }, [tab]);

  // keep the view pinned to the bottom while text streams in, unless the user scrolled up
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.messages?.length, live?.text, live?.reasoning]);
  const onScroll = () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const patchChat = async (patch) => {
    const updated = await api.put(`/chats/${chatId}`, patch);
    setChat(updated);
    if ('title' in patch || 'mode' in patch) onChanged();
    return updated;
  };
  const replaceMessage = (m) => setChat((c) => {
    const exists = c.messages.some((x) => x.id === m.id);
    return { ...c, messages: exists ? c.messages.map((x) => (x.id === m.id ? m : x)) : [...c.messages, m] };
  });

  const generate = async (kind, opts = {}) => {
    if (live) return;
    const last = chat.messages[chat.messages.length - 1];
    stick.current = true;
    setLive({ kind, text: '', reasoning: '', targetId: kind === 'regenerate' || kind === 'continue' ? last?.id : null, meta: null });
    const gd = opts.guidance ?? (showGuidance ? guidance : '');
    let impersonated = '';
    try {
      await streamPost(`/chats/${chatId}/generate`, { kind, guidance: gd }, {
        meta: (m) => setLive((l) => l && { ...l, meta: m }),
        token: (t) => {
          if (kind === 'impersonate') { impersonated += t; setDraft(impersonated); }
          setLive((l) => l && { ...l, text: l.text + t });
        },
        reasoning: (t) => setLive((l) => l && { ...l, reasoning: l.reasoning + t }),
        done: (d) => {
          if (d.impersonation) setDraft(d.impersonation);
          else if (d.id) {
            replaceMessage(d);
            setInspect(null);
          }
          setLive(null);
          if (gd && showGuidance) setGuidance('');
          onChanged();
        },
        tracker: (t) => {
          if (t.status === 'running') setTracking(true);
          if (t.error) notify(`Map / scene update failed: ${t.error}`, 'error');
          if (t.status === 'done') {
            setTracking(false);
            setChat((c) => ({
              ...c,
              map: t.map,
              scene: t.scene,
              messages: c.messages.map((m) => (m.id === t.messageId ? { ...m, meta: { ...m.meta, tldr: t.tldr, mapLog: t.log } } : m))
            }));
          }
        },
        error: (e) => notify(e.message, 'error')
      });
    } catch (e) {
      if (e.name !== 'AbortError') notify(e.message, 'error');
    } finally {
      setLive(null);
      setTracking(false);
    }
  };

  const send = async (text = draft, { asOoc = ooc } = {}) => {
    if (live || tracking) return;
    const content = text.trim();
    if (content) {
      try {
        const m = await api.post(`/chats/${chatId}/messages`, { role: asOoc ? 'system' : 'user', content });
        replaceMessage(m);
        if (text === draft) setDraft('');
      } catch (e) {
        return notify(e.message, 'error');
      }
    }
    await generate('reply');
  };

  const stop = () => api.post(`/chats/${chatId}/stop`).catch(() => {});

  // ---------------------------------------------------------------- message actions
  const msgAction = {
    edit: async (m, content) => {
      replaceMessage(await api.put(`/messages/${m.id}`, { content }));
      setEditing(null);
    },
    del: async (m, after) => {
      if (after && !confirm('Delete this message and everything after it?')) return;
      await api.del(`/messages/${m.id}${after ? '?after=1' : ''}`);
      await refresh();
    },
    hide: async (m) => replaceMessage(await api.put(`/messages/${m.id}`, { hidden: !m.hidden })),
    swipe: async (m, idx) => {
      if (idx >= m.swipes.length) return generate('regenerate'); // swiping past the last version makes a new one
      replaceMessage(await api.post(`/messages/${m.id}/swipe`, { idx }));
      if (chat.mode === 'roleplay') {
        const c = await api.get(`/chats/${chatId}`);
        setChat(c);
      }
    },
    deleteSwipe: async (m) => {
      replaceMessage(await api.del(`/messages/${m.id}/swipes/${m.swipe_idx}`));
    },
    branch: async (m) => {
      const r = await api.post(`/chats/${chatId}/branch`, { messageId: m.id });
      onChanged();
      notify('Branched into a new chat');
      onOpenChat(r.id);
    },
    append: async (m) => {
      const ms = chat.manuscript?.trim() ? `${chat.manuscript.trimEnd()}\n\n${m.content.trim()}\n` : `${m.content.trim()}\n`;
      await patchChat({ manuscript: ms });
      notify('Added to the manuscript');
      setTab('manuscript');
      setPanelOpen(true);
    },
    copy: (m) => navigator.clipboard?.writeText(m.content).then(() => notify('Copied')),
    inspect: (m) => {
      setInspect(m.id);
      setTab('context');
      setPanelOpen(true);
    }
  };

  if (!chat) return <div className="chat"><div className="chat-center"><div className="empty muted"><Dots /></div></div></div>;

  const rp = chat.mode === 'roleplay';
  const messages = chat.messages;
  const last = messages[messages.length - 1];
  const busy = !!live || tracking;
  const model = chat.model || (rp ? settings?.roleplayModel : settings?.writingModel);
  const inspected = messages.find((m) => m.id === inspect) || [...messages].reverse().find((m) => m.role === 'assistant');

  const roll = (sides = 20) => {
    const n = 1 + Math.floor(Math.random() * sides);
    setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}*rolls a d${sides}: ${n}*`);
    inputRef.current?.focus();
  };

  return (
    <div className="chat" style={{ '--side-w': `${panelWidth}px` }}>
      <div className="chat-center">
        <header className="chat-head">
          <button className="icon ghost mobile-only" onClick={onMenu}>☰</button>
          <span className={`badge ${chat.mode}`}>{rp ? '⚔️ Roleplay' : '✍️ Writing'}</span>
          <input
            className="chat-title"
            defaultValue={chat.title}
            key={chat.title}
            onBlur={(e) => e.target.value.trim() && e.target.value !== chat.title && patchChat({ title: e.target.value.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
            size={Math.max(8, Math.min(40, chat.title.length + 2))}
          />
          <span className="model ellipsis" title={model}>{model}</span>
          <span className="grow" />
          {rp && (
            <button className={`icon ghost ${showTldr ? 'active' : ''}`} title="Show a plain-words summary under each narrator message" onClick={() => setShowTldr(!showTldr)}>
              {showTldr ? '💡' : '💭'}
            </button>
          )}
          <button className="icon ghost" title="Chat settings" onClick={() => setShowSettings('general')}>⚙️</button>
          <button className="icon ghost" title="Export" onClick={() => download(`/api/chats/${chatId}/export?format=md`)}>⤓</button>
          <button className="icon ghost" title={panelOpen ? 'Hide panel' : 'Show panel'} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? '⇥' : '⇤'}</button>
        </header>

        <div className="messages" ref={scroller} onScroll={onScroll}>
          <div className="msg-col">
            {!messages.length && !live && <ChatIntro chat={chat} onSettings={setShowSettings} onStart={() => generate('reply')} />}
            {messages.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                chat={chat}
                isLast={i === messages.length - 1}
                live={live && live.targetId === m.id ? live : null}
                editing={editing === m.id}
                setEditing={setEditing}
                actions={msgAction}
                busy={busy}
                showTldr={rp && showTldr}
              />
            ))}
            {live && !live.targetId && live.kind !== 'impersonate' && (
              <div className="msg assistant">
                <div className="msg-head"><span className="who">{rp ? chat.names.char : 'AI'}</span> <Dots /></div>
                {live.reasoning && <details className="reasoning" open={!live.text}><summary>Thinking…</summary><pre>{live.reasoning}</pre></details>}
                <Prose text={live.text} className={live.text ? 'cursor' : ''} />
              </div>
            )}
          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            {!rp && settings?.writingQuickPrompts?.length > 0 && (
              <div className="quick">
                {settings.writingQuickPrompts.map((q) => (
                  <button key={q.label} className="chip" disabled={busy} title={`${q.text}\n\n(Shift-click to edit before sending)`} onClick={(e) => (e.shiftKey ? setDraft(q.text) : send(q.text, { asOoc: false }))}>
                    {q.label}
                  </button>
                ))}
              </div>
            )}
            {showGuidance && (
              <div className="guidance">
                <span title="Direction for the next reply only — the AI follows it without it becoming part of the story">🧭</span>
                <input autoFocus value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder={rp ? 'Steer the next reply: "the guard recognises me", "a storm rolls in"…' : 'Steer the next reply: "more dialogue", "end on a cliffhanger"…'} />
                <button className="icon ghost" onClick={() => { setShowGuidance(false); setGuidance(''); }}>✕</button>
              </div>
            )}
            <div className="composer-tools">
              <button className="ghost small" disabled={busy || last?.role !== 'assistant'} onClick={() => generate('regenerate')} title="New version of the last reply (old versions stay as swipes)">↻ Regenerate</button>
              <button className="ghost small" disabled={busy || last?.role !== 'assistant'} onClick={() => generate('continue')} title="Make the last reply longer">⏩ Continue</button>
              {rp && <button className="ghost small" disabled={busy} onClick={() => generate('impersonate')} title="Let the AI draft your next move (you can edit it before sending)">🎭 Write for me</button>}
              <span className="sep" />
              <button className={`ghost small ${showGuidance ? 'active' : ''}`} onClick={() => setShowGuidance(!showGuidance)} title="Steer the next reply">🧭 Direct</button>
              <button className={`ghost small ${ooc ? 'ooc-on' : ''}`} onClick={() => setOoc(!ooc)} title="Send an out-of-character note (the AI reads it but it isn't part of the story)">{ooc ? '💬 OOC on' : '💬 OOC'}</button>
              {rp && <button className="ghost small" onClick={() => roll(20)} title="Roll a d20 into your message">🎲 d20</button>}
              <span className="grow" />
              <span className="status-line">
                {live && <>{live.kind === 'impersonate' ? 'Drafting your move' : live.meta ? 'Writing' : 'Gathering context'} <Dots /></>}
                {!live && tracking && <>🗺 Updating map & scene <Dots /></>}
              </span>
            </div>
            <div className="composer-box">
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                placeholder={ooc ? 'Out-of-character note to the AI…' : rp ? `What does ${chat.names.user} do or say?` : 'Talk to your writing partner… (Enter to send, Shift+Enter for a new line)'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                style={{ height: Math.min(260, Math.max(38, 22 * draft.split('\n').length + 16)) }}
              />
              {live ? (
                <button className="danger" onClick={stop} title="Stop (keeps what was written so far)">■ Stop</button>
              ) : (
                <button className="primary" disabled={tracking} onClick={() => send()} title={draft.trim() ? 'Send' : 'Let the AI take the next turn'}>
                  {draft.trim() ? 'Send' : '➤'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <aside className={`side-panel ${panelOpen ? '' : 'closed'}`} style={panelOpen ? undefined : { display: 'none' }}>
        <ResizeHandle width={panelWidth} setWidth={setPanelWidth} />
        <div className="panel-tabs">
          {TABS[chat.mode].map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
          <span className="grow" />
          <button className="icon ghost mobile-only" onClick={() => setPanelOpen(false)}>✕</button>
        </div>
        {tab === 'scene' && rp && (
          <div className="panel-split">
            <div className="pane pane-map">
              <MapPanel chat={chat} setChat={setChat} notify={notify} tracking={tracking} onAction={(t) => { setDraft((d) => (d ? `${d} ${t}` : t)); inputRef.current?.focus(); }} />
            </div>
            <div className="pane pane-scene">
              <ScenePanel chat={chat} setChat={setChat} notify={notify} tracking={tracking} busy={busy} onOption={(t) => { setDraft(t); inputRef.current?.focus(); }} />
            </div>
          </div>
        )}
        {tab === 'manuscript' && !rp && (
          <div className="panel-body">
            <div className="manuscript">
              <div className="row space small">
                <span className="muted">
                  {wordCount(chat.manuscript).toLocaleString()} words · the AI sees the last ~{Math.round(((chat.options.manuscriptTokens ?? settings?.manuscriptTokens ?? 2500) * 3.6) / 5.7).toLocaleString()} words
                </span>
                <span className="row">
                  <button className="small" onClick={() => download(`/api/chats/${chatId}/export?format=manuscript`)}>⤓ .md</button>
                </span>
              </div>
              <AutoSaveText
                value={chat.manuscript}
                onSave={async (t) => {
                  await api.put(`/chats/${chatId}`, { manuscript: t });
                  setChat((c) => ({ ...c, manuscript: t }));
                }}
                placeholder="Your manuscript. Paste a draft, write here directly, or press ＋ on any AI reply to add it. The AI always sees the end of this, so it can continue in your voice."
              />
            </div>
          </div>
        )}
        {tab === 'notes' && (
          <div className="panel-body notes">
            <p className="hint" style={{ marginTop: 0 }}>
              {rp
                ? 'Scenario & world notes. Always in the narrator\'s context: the premise, the rules of the world, things that must stay true.'
                : 'Story notes & outline. Always in the AI\'s context: premise, outline, style rules, character arcs, things to remember.'}
            </p>
            <AutoSaveText
              value={chat.notes}
              rows={18}
              onSave={async (t) => {
                await api.put(`/chats/${chatId}`, { notes: t });
                setChat((c) => ({ ...c, notes: t }));
              }}
              placeholder={rp ? 'e.g. A low-fantasy port city under martial law. Magic is illegal. The player is a smuggler owed money by half the docks…' : 'e.g. Literary thriller, close third person on Mira, past tense. Outline:\n1. …'}
            />
            <span className="hint">~{tokenCount(chat.notes)} tokens every message</span>
          </div>
        )}
        {tab === 'sources' && <div className="panel-body"><SourcesPanel chat={chat} setChat={setChat} patchChat={patchChat} notify={notify} openSettings={() => setShowSettings('lore')} /></div>}
        {tab === 'context' && (
          <div className="panel-body">
            <ContextPanel chat={chat} setChat={setChat} message={inspected} live={live} notify={notify} />
          </div>
        )}
      </aside>

      {showSettings && (
        <ChatSettings
          chat={chat}
          models={models}
          settings={settings}
          initialTab={showSettings}
          notify={notify}
          onClose={() => setShowSettings(null)}
          onSave={async (patch) => { await patchChat(patch); }}
          onDelete={async () => {
            if (!confirm(`Delete "${chat.title}" and all its messages?`)) return;
            await api.del(`/chats/${chatId}`);
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

function ResizeHandle({ width, setWidth }) {
  const onDown = (e) => {
    const startX = e.clientX;
    const startW = width;
    const move = (ev) => setWidth(Math.max(320, Math.min(900, startW + (startX - ev.clientX))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="resize-handle" onPointerDown={onDown} />;
}

function ChatIntro({ chat, onSettings, onStart }) {
  const rp = chat.mode === 'roleplay';
  return (
    <div className="empty" style={{ padding: '40px 10px' }}>
      <div className="empty-icon">{rp ? '⚔️' : '✍️'}</div>
      <h2>{rp ? 'Set the stage' : 'Start writing'}</h2>
      <div className="muted small" style={{ lineHeight: 1.6 }}>
        {rp ? (
          <>
            Add characters and pick who you play in <a onClick={() => onSettings('characters')}>chat settings</a>, write the premise in the <b>Scenario</b> tab, attach{' '}
            <a onClick={() => onSettings('lore')}>lorebooks</a>, then write your first move — or let the narrator open the scene.
          </>
        ) : (
          <>
            Tell your writing partner what you're working on, paste your draft into the <b>Manuscript</b> tab, put your outline in <b>Notes</b>, and attach{' '}
            <a onClick={() => onSettings('lore')}>lorebooks and source documents</a>. Your instructions for this project go in{' '}
            <a onClick={() => onSettings('general')}>chat settings → system prompt</a>.
          </>
        )}
      </div>
      {rp && <button className="primary" style={{ marginTop: 16 }} onClick={onStart}>▶ Open the scene</button>}
    </div>
  );
}

function Message({ m, chat, isLast, live, editing, setEditing, actions, busy, showTldr }) {
  const rp = chat.mode === 'roleplay';
  const [text, setText] = useState(m.content);
  useEffect(() => setText(m.content), [m.content, editing]);
  const who = m.role === 'user' ? (rp ? chat.names.user : 'You') : m.role === 'system' ? 'OOC note' : rp ? chat.names.char : 'AI';
  const content = live ? (live.kind === 'continue' ? `${m.content} ${live.text}` : live.text) : m.content;
  const reasoning = live ? live.reasoning : m.reasoning;
  const swipes = m.swipes?.length || 1;
  const meta = m.meta || {};
  const lore = (meta.lore || []).filter((x) => !x.skipped).length;
  const docs = meta.docs?.chunks?.length || 0;

  return (
    <div className={`msg ${m.role} ${m.hidden ? 'hidden' : ''}`}>
      <div className="msg-head">
        <span className="who">{who}</span>
        {m.hidden && <span className="badge" title="Left out of the AI's context">hidden</span>}
        {m.role === 'assistant' && (swipes > 1 || isLast) && !live && (
          <span className="swipes">
            <button className="ghost" disabled={busy || m.swipe_idx === 0} onClick={() => actions.swipe(m, m.swipe_idx - 1)}>‹</button>
            {m.swipe_idx + 1}/{swipes}
            <button className="ghost" disabled={busy || (!isLast && m.swipe_idx >= swipes - 1)} title={isLast && m.swipe_idx >= swipes - 1 ? 'Generate a new version' : 'Next version'} onClick={() => actions.swipe(m, m.swipe_idx + 1)}>›</button>
          </span>
        )}
        {live && <Dots />}
        {!editing && !live && (
          <span className="msg-actions">
            {m.role === 'assistant' && !rp && <button className="ghost" title="Add to manuscript" onClick={() => actions.append(m)}>＋ Manuscript</button>}
            <button className="ghost" title="Edit" onClick={() => setEditing(m.id)}>✎</button>
            <button className="ghost" title="Copy" onClick={() => actions.copy(m)}>⧉</button>
            {m.role === 'assistant' && <button className="ghost" title="What went into this reply" onClick={() => actions.inspect(m)}>ⓘ</button>}
            <button className="ghost" title="Branch: copy the chat up to here into a new chat" onClick={() => actions.branch(m)}>⑂</button>
            <button className="ghost" title={m.hidden ? 'Include in context again' : 'Hide from the AI (keeps it in the chat)'} onClick={() => actions.hide(m)}>{m.hidden ? '◉' : '◌'}</button>
            {swipes > 1 && <button className="ghost" title="Delete this version" onClick={() => actions.deleteSwipe(m)}>⌫</button>}
            <button className="ghost danger" title="Delete (Shift-click: delete everything from here on)" onClick={(e) => actions.del(m, e.shiftKey)}>🗑</button>
          </span>
        )}
      </div>
      {reasoning && <details className="reasoning" open={live && !live.text}><summary>{live ? 'Thinking…' : 'Reasoning'}</summary><pre>{reasoning}</pre></details>}
      {editing ? (
        <div className="msg-edit col">
          <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) actions.edit(m, text); if (e.key === 'Escape') setEditing(null); }} />
          <div className="row">
            <AsyncButton className="primary small" onClick={() => actions.edit(m, text)}>Save</AsyncButton>
            <button className="small" onClick={() => setEditing(null)}>Cancel</button>
            <span className="hint">Ctrl+Enter to save, Esc to cancel</span>
          </div>
        </div>
      ) : (
        <Prose text={content} className={live ? 'cursor' : ''} />
      )}
      {showTldr && m.role === 'assistant' && meta.tldr && !live && !editing && (
        <div className="tldr"><b>In short:</b> {meta.tldr}</div>
      )}
      {m.role === 'assistant' && !live && (lore || docs || meta.finish === 'length' || meta.finish === 'stopped') ? (
        <div className="msg-meta-line">
          {lore > 0 && <button className="ghost" onClick={() => actions.inspect(m)}>📚 {lore} lore</button>}
          {docs > 0 && <button className="ghost" onClick={() => actions.inspect(m)}>📄 {docs} excerpt{docs > 1 ? 's' : ''}</button>}
          {meta.finish === 'length' && <span title="The reply hit the length limit. Use Continue to extend it.">✂ cut at length limit</span>}
          {meta.finish === 'stopped' && <span>■ stopped</span>}
        </div>
      ) : null}
    </div>
  );
}
