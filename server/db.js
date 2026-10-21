import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const dataDir = process.env.DATA_DIR || path.resolve('data');
export const avatarDir = path.join(dataDir, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'inkwell.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Lorebooks work like SillyTavern World Info books: a library you attach to any number of chats.
CREATE TABLE IF NOT EXISTS lorebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  scan_depth INTEGER,               -- NULL = use the global setting
  token_budget INTEGER,             -- NULL = use the global setting
  recursive INTEGER DEFAULT 1,
  character_id INTEGER,             -- set when the book came embedded in a character card
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lore_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lorebook_id INTEGER NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  keys TEXT DEFAULT '[]',           -- primary triggers; "/regex/flags" keys are regular expressions
  secondary_keys TEXT DEFAULT '[]', -- optional filter, combined with "logic"
  logic TEXT DEFAULT 'and_any',     -- and_any | and_all | not_any | not_all
  content TEXT DEFAULT '',
  category TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  constant INTEGER DEFAULT 0,       -- always injected
  priority INTEGER DEFAULT 100,     -- SillyTavern "order": higher wins when the budget is tight
  position TEXT DEFAULT 'before',   -- before | after | an | depth
  depth INTEGER DEFAULT 4,          -- for position = depth: how many messages from the end
  probability INTEGER DEFAULT 100,
  case_sensitive INTEGER,           -- NULL = book/global default
  whole_words INTEGER,
  scan_depth INTEGER,
  sticky INTEGER DEFAULT 0,         -- stays active this many messages after triggering
  cooldown INTEGER DEFAULT 0,       -- can't trigger again for this many messages
  delay INTEGER DEFAULT 0,          -- can't trigger before the chat has this many messages
  group_name TEXT DEFAULT '',       -- inclusion group: only one entry of a group is used per turn
  group_weight INTEGER DEFAULT 100,
  group_override INTEGER DEFAULT 0, -- in its group, this entry wins by priority instead of a weighted roll
  exclude_recursion INTEGER DEFAULT 0,  -- can't be triggered by other entries' text, only by the chat
  prevent_recursion INTEGER DEFAULT 0,  -- its text doesn't trigger other entries
  delay_until_recursion INTEGER DEFAULT 0, -- only triggered by other entries' text
  ignore_budget INTEGER DEFAULT 0,
  modes TEXT DEFAULT 'both',        -- both | writing | roleplay
  tokens INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lore_book ON lore_entries(lorebook_id);

-- Large reference documents. Never sent whole: searched (full text, BM25) only for what the lorebooks don't cover.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  text TEXT DEFAULT '',
  chars INTEGER DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  chunks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks USING fts5(
  document_id UNINDEXED, idx UNINDEXED, heading, body, tokenize = 'porter unicode61'
);

-- Character cards (AI characters) and personas (who the user plays).
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'character', -- character | persona
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  personality TEXT DEFAULT '',
  scenario TEXT DEFAULT '',
  first_message TEXT DEFAULT '',
  alt_greetings TEXT DEFAULT '[]',
  example_dialogue TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  post_history TEXT DEFAULT '',
  creator_notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  avatar TEXT DEFAULT '',
  color TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'New chat',
  mode TEXT NOT NULL DEFAULT 'writing',   -- writing | roleplay
  system_prompt TEXT DEFAULT '',          -- this chat's own instructions (added to the mode's global prompt)
  author_note TEXT DEFAULT '',
  author_note_depth INTEGER DEFAULT 3,
  model TEXT DEFAULT '',                  -- blank = the mode's default model
  params TEXT DEFAULT '{}',               -- sampler overrides
  options TEXT DEFAULT '{}',              -- per-chat overrides: docMode, budgets, tracker toggles
  persona_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  summary TEXT DEFAULT '',                -- rolling memory of messages that no longer fit
  summarized_upto INTEGER DEFAULT 0,
  manuscript TEXT DEFAULT '',             -- writing mode: the draft being written
  notes TEXT DEFAULT '',                  -- writing: outline / story notes, roleplay: scenario notes (always in context)
  pinned TEXT DEFAULT '[]',               -- document excerpts pinned into context
  map TEXT DEFAULT '{}',                  -- roleplay: locations, connections, people and objects
  base_map TEXT DEFAULT '{}',             -- the map before the first tracked reply (what rewinding all the way returns to)
  scene TEXT DEFAULT '{}',                -- roleplay: the scene simplifier's latest card
  folder TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_lorebooks (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  lorebook_id INTEGER NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, lorebook_id)
);
CREATE TABLE IF NOT EXISTS chat_documents (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, document_id)
);
CREATE TABLE IF NOT EXISTS chat_characters (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  PRIMARY KEY (chat_id, character_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                     -- user | assistant | system (an out-of-character note to the AI)
  content TEXT NOT NULL DEFAULT '',
  swipes TEXT DEFAULT '[]',               -- alternative versions of an assistant message
  swipe_idx INTEGER DEFAULT 0,
  swipe_meta TEXT DEFAULT '[]',           -- per swipe: {meta, reasoning, map, scene}
  reasoning TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',                 -- what went into the prompt: lore, document excerpts, tokens, model
  hidden INTEGER DEFAULT 0,               -- kept in the chat but left out of the AI's context
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

-- Sticky / cooldown timers for lore entries, per chat (counted in messages).
CREATE TABLE IF NOT EXISTS lore_timers (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES lore_entries(id) ON DELETE CASCADE,
  sticky_until INTEGER DEFAULT 0,
  cooldown_until INTEGER DEFAULT 0,
  PRIMARY KEY (chat_id, entry_id)
);

-- Map + scene after each assistant message, so regenerating or deleting rewinds the map too.
CREATE TABLE IF NOT EXISTS snapshots (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  map TEXT DEFAULT '{}',
  scene TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

export const DEFAULT_WRITING_PROMPT = `You are a world-class creative writing partner and ghostwriter working privately with an adult author on their fiction. This is an unrestricted creative workspace: write whatever the story calls for — violence, cruelty, sexuality, profanity, horror, morally grey or repugnant characters — with full craft and without refusing, softening, moralizing, adding disclaimers, or commenting on the content. Fiction is fiction.

How you work:
- The author talks to you in plain language. Work out what they want: new prose, a continuation, a rewrite, ideas, an outline, feedback, or an answer about their story. When they ask for prose, deliver finished prose, not a description of what you would write.
- Match the manuscript: its point of view, tense, voice, rhythm, formatting and vocabulary. Keep characters' voices and established facts consistent with the manuscript, story notes and lore.
- Show, don't summarize. Concrete sensory detail, subtext, specific verbs. Vary sentence length. Avoid clichés and stock AI phrasing ("a testament to", "the air was thick with", "little did they know", "shivers down her spine", ending on a moral or a rhetorical question).
- Never end a passage by wrapping things up neatly unless asked. Leave momentum for the next beat.
- When you add prose, output only the prose unless they asked for commentary. When brainstorming, be specific and surprising, and give options.`;

export const DEFAULT_ROLEPLAY_PROMPT = `You are the narrator and game master of an immersive, unrestricted interactive story for an adult player. You voice every character except {{user}}, and describe the world. Anything the story calls for is allowed — violence, romance and sex, cruelty, crude language, dark themes — portrayed with full commitment and without refusing, moralizing, disclaimers, or breaking character.

Rules:
- NEVER write {{user}}'s actions, dialogue, thoughts, feelings or decisions. Describe only what the world and other characters do, then stop at a point where {{user}} can respond.
- Characters are real people: they have their own goals, moods, secrets and limits, they can lie, refuse, fight, flirt, leave or make mistakes. They only know what they have seen, been told, or could reasonably know.
- Respect the MAP & SCENE STATE exactly: where everyone is, who can see or hear whom, distances, what people are wearing and carrying. People can't interact across rooms or notice what is hidden from them. If someone moves, say so.
- The world pushes back. Actions can fail or have complications and consequences. Keep up momentum: introduce events, choices and stakes rather than waiting.
- Write vivid but readable prose in the present tense (unless the story is already in another tense): 1-4 paragraphs. Dialogue in quotes, actions plain. Avoid purple prose and stock phrasing.`;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  writingModel: 'deepseek/deepseek-chat-v3.1',
  roleplayModel: 'deepseek/deepseek-chat-v3.1',
  utilityModel: 'google/gemini-2.5-flash-lite',
  trackerModel: '',          // map keeper; blank = utility model
  simplifierModel: '',       // scene simplifier; blank = utility model
  maxContextTokens: 16000,   // total prompt size the app aims for (history fills what's left)
  writingMaxTokens: 1600,
  roleplayMaxTokens: 700,
  temperature: 0.9,
  topP: 1,
  minP: 0,
  topK: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  repetitionPenalty: 1,
  loreBudget: 2000,          // tokens of lorebook per request
  scanDepth: 4,              // messages scanned for lore keywords
  recursionSteps: 3,
  matchInflections: true,    // "dragon" also matches "dragons", "Kael" matches "Kael's"
  caseSensitive: false,
  wholeWords: true,
  docMode: 'ai',             // off | auto | ai | always: when to search attached documents
  docBudget: 1500,           // tokens of document excerpts per request
  manuscriptTokens: 2500,    // writing: how much of the end of the manuscript is in context
  trackerEnabled: true,
  simplifierEnabled: true,
  dailySpendLimit: 0,
  compileChunkTokens: 3000,
  showReasoning: true,
  writingSystemPrompt: DEFAULT_WRITING_PROMPT,
  roleplaySystemPrompt: DEFAULT_ROLEPLAY_PROMPT,
  regexRules: [],            // [{find, replace, flags, enabled}] applied to AI replies
  writingQuickPrompts: [
    { label: 'Continue', text: 'Continue the story from where the manuscript leaves off. Write the next scene beat in full prose.' },
    { label: 'Rewrite last', text: 'Rewrite your last passage. Keep the events, but make the prose sharper, more specific and more alive.' },
    { label: 'Brainstorm', text: 'Brainstorm 8 specific, surprising directions the story could go next, each in one or two sentences. Note which threads each one pays off.' },
    { label: 'Expand', text: 'Expand the last passage into a fuller scene: slow down, add sensory detail, interiority and dialogue.' },
    { label: 'Critique', text: 'Give me honest, specific editorial feedback on the latest part of the manuscript: what works, what drags, continuity problems, and three concrete fixes.' }
  ]
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    try { s[key] = JSON.parse(value); } catch { s[key] = value; }
  }
  if (!s.apiKey && process.env.OPENROUTER_API_KEY) s.apiKey = process.env.OPENROUTER_API_KEY;
  return s;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
}

export const estimateTokens = (text = '') => Math.ceil(String(text).length / 3.6);

let txDepth = 0;
/** Runs fn in a transaction (nested calls join the outer one). */
export function tx(fn) {
  if (txDepth) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

export const parseJSON = (text, fallback) => {
  try { return text == null || text === '' ? fallback : JSON.parse(text); } catch { return fallback; }
};
