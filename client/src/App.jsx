import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, load, store } from './api.js';
import { Avatar, Empty, ModelList, timeAgo } from './components.jsx';
import ChatView from './views/ChatView.jsx';
import NewChat from './views/NewChat.jsx';
import Lorebooks from './views/Lorebooks.jsx';
import Characters from './views/Characters.jsx';
import Documents from './views/Documents.jsx';
import Settings from './views/Settings.jsx';
import Usage from './views/Usage.jsx';

const NAV = [
  { id: 'lorebooks', label: 'Lorebooks', icon: '📚' },
  { id: 'characters', label: 'Characters', icon: '🎭' },
  { id: 'documents', label: 'Documents', icon: '📄' },
  { id: 'usage', label: 'Usage', icon: '💲' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
];

export default function App() {
  const [view, setView] = useState(load('view', 'home'));
  const [chatId, setChatId] = useState(load('chatId', null));
  const [chats, setChats] = useState([]);
  const [settings, setSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [toast, setToast] = useState(null);
  const [newChat, setNewChat] = useState(null); // { mode, characterIds }
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState(load('theme', 'dark'));
  const [font, setFont] = useState(load('font', 'serif'));

  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshChats = useCallback(() => api.get('/chats').then(setChats).catch((e) => notify(e.message, 'error')), [notify]);
  const refreshSettings = useCallback(() => api.get('/settings').then(setSettings), []);

  useEffect(() => {
    refreshChats();
    refreshSettings();
    api.get('/models').then(setModels).catch(() => {});
  }, []);
  useEffect(() => store('view', view), [view]);
  useEffect(() => store('chatId', chatId), [chatId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store('theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.font = font;
    store('font', font);
  }, [font]);
  useEffect(() => {
    if (view === 'chat' && chats.length && !chats.some((c) => c.id === chatId)) setView('home');
  }, [chats]);

  const openChat = (id) => {
    setChatId(id);
    setView('chat');
    setSidebarOpen(false);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? chats.filter((c) => `${c.title} ${c.charName || ''} ${c.preview || ''}`.toLowerCase().includes(q)) : chats;
  }, [chats, query]);
  const groups = useMemo(() => {
    const out = [];
    const day = 86400000;
    const label = (c) => {
      const age = Date.now() - new Date(String(c.updated_at).replace(' ', 'T') + 'Z').getTime();
      return age < day ? 'Today' : age < 7 * day ? 'This week' : age < 30 * day ? 'This month' : 'Older';
    };
    for (const c of filtered) {
      const g = c.folder || label(c);
      let grp = out.find((x) => x.name === g);
      if (!grp) out.push((grp = { name: g, items: [] }));
      grp.items.push(c);
    }
    return out;
  }, [filtered]);

  const noKey = settings && !settings.hasApiKey;

  return (
    <div className="app">
      <ModelList models={models} />
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-name">🖋 Inkwell</span>
          <span className="row">
            <button className="icon ghost" title="Prose font" onClick={() => setFont(font === 'serif' ? 'sans' : 'serif')}>{font === 'serif' ? 'Aa' : 'Ag'}</button>
            <button className="icon ghost" title="Light / dark" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀' : '☾'}</button>
            <button className="icon ghost mobile-only" onClick={() => setSidebarOpen(false)}>✕</button>
          </span>
        </div>
        <div className="new-chat">
          <button onClick={() => setNewChat({ mode: 'writing' })}>✍️ Write</button>
          <button onClick={() => setNewChat({ mode: 'roleplay' })}>⚔️ Roleplay</button>
        </div>
        <input className="chat-search" placeholder="Search chats…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chat-list">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="chat-group">{g.name}</div>
              {g.items.map((c) => (
                <button key={c.id} className={`chat-item ${view === 'chat' && c.id === chatId ? 'active' : ''}`} onClick={() => openChat(c.id)}>
                  {c.avatar ? <Avatar c={{ avatar: c.avatar, name: c.charName }} size={30} /> : <span className={`mode-dot ${c.mode}`}>{c.mode === 'writing' ? '✍️' : '⚔️'}</span>}
                  <span className="chat-item-text">
                    <div className="chat-item-title ellipsis">{c.title}</div>
                    <div className="tiny muted ellipsis">{c.messageCount ? `${c.messageCount} msgs · ${timeAgo(c.updated_at)}` : 'Empty'}</div>
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!chats.length && <p className="muted small" style={{ padding: '10px' }}>No chats yet. Start one above.</p>}
        </div>
        <nav className="side-nav">
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? 'active' : ''} onClick={() => { setView(n.id); setSidebarOpen(false); }}>
              <span>{n.icon}</span> {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {noKey && view !== 'settings' && (
          <div className="callout warn" style={{ margin: '10px 16px 0' }}>
            Add your OpenRouter API key in <a onClick={() => setView('settings')}>Settings</a> to start writing.
          </div>
        )}
        {view === 'chat' && chatId ? (
          <ChatView
            key={chatId}
            chatId={chatId}
            settings={settings}
            models={models}
            notify={notify}
            onChanged={refreshChats}
            onOpenChat={openChat}
            onMenu={() => setSidebarOpen(true)}
            onDeleted={() => { setView('home'); refreshChats(); }}
          />
        ) : (
          <div className="page-scroll">
            <button className="icon ghost mobile-only" style={{ margin: 10 }} onClick={() => setSidebarOpen(true)}>☰</button>
            {view === 'lorebooks' && <Lorebooks notify={notify} />}
            {view === 'characters' && <Characters notify={notify} onStart={(c) => setNewChat({ mode: 'roleplay', characterIds: [c.id] })} />}
            {view === 'documents' && <Documents notify={notify} />}
            {view === 'settings' && settings && <Settings settings={settings} models={models} notify={notify} onSaved={refreshSettings} />}
            {view === 'usage' && <Usage notify={notify} />}
            {(view === 'home' || (view === 'chat' && !chatId)) && <Welcome onNew={(mode) => setNewChat({ mode })} onNav={setView} />}
          </div>
        )}
      </main>

      {newChat && (
        <NewChat
          initial={newChat}
          notify={notify}
          onClose={() => setNewChat(null)}
          onCreated={(c) => { setNewChat(null); refreshChats(); openChat(c.id); }}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.msg}</div>}
    </div>
  );
}

function Welcome({ onNew, onNav }) {
  return (
    <Empty icon="🖋" title="Inkwell">
      <p>An unrestricted writing and roleplay studio for any model on OpenRouter.</p>
      <div className="welcome-grid">
        <div className="mode-card on writing" onClick={() => onNew('writing')}>
          <div className="big">✍️</div>
          <div className="t">Writing</div>
          <div className="d">Talk to the AI and draft together. A live manuscript, story notes, lorebooks, and your source documents searched only when the lore doesn't cover something.</div>
        </div>
        <div className="mode-card on roleplay" onClick={() => onNew('roleplay')}>
          <div className="big">⚔️</div>
          <div className="t">Roleplay</div>
          <div className="d">A narrator plays the world. A live map tracks every place and person, and the scene simplifier tells you what's going on in plain words.</div>
        </div>
      </div>
      <p className="small" style={{ marginTop: 20 }}>
        Set up your world in <a onClick={() => onNav('lorebooks')}>Lorebooks</a> (SillyTavern World Info imports work), <a onClick={() => onNav('characters')}>Characters</a> (V2/V3 cards) and{' '}
        <a onClick={() => onNav('documents')}>Documents</a>.
      </p>
    </Empty>
  );
}
