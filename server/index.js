import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, getSettings, saveSettings, estimateTokens, DEFAULT_SETTINGS, avatarDir, parseJSON, tx } from './db.js';
import { extractText, readPngCard, writePngCard, parseCharacterCard, toCharacterCard } from './files.js';
import {
  insertEntries, updateEntry, publicEntry, parseSillyTavernLorebook, exportSillyTavern, importEntries, activateLore,
  toCharacterBookEntries, startCompile, getJob, estimateCompile
} from './lorebook.js';
import { addDocument, deleteDocument, searchForUser, getChunk } from './documents.js';
import { buildPrompt, getChat, chatNames, macros } from './context.js';
import {
  generate, stopGeneration, chatMessages, publicMessage, selectSwipe, syncTracker, rebuildMap, saveMapEdit, refreshScene, suggestLore, branchChat
} from './generate.js';
import { loadMap, layout } from './tracker.js';
import { listModels, httpError, spentToday } from './openrouter.js';
import { exportAll, importAll } from './backup.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
app.use(express.json({ limit: '200mb' }));
const api = express.Router();
const id = (v) => Number(v);

const COLORS = ['#7c6cff', '#ff8ac2', '#5ec8ff', '#ffb86b', '#7ee0a1', '#ff6b6b', '#c79bff', '#f7d774', '#6be4d8'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];

// ---------------------------------------------------------------- settings & usage
api.get('/settings', (req, res) => {
  const s = getSettings();
  res.json({
    ...s,
    apiKey: undefined,
    hasApiKey: !!s.apiKey,
    apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '',
    defaults: { writingSystemPrompt: DEFAULT_SETTINGS.writingSystemPrompt, roleplaySystemPrompt: DEFAULT_SETTINGS.roleplaySystemPrompt, writingQuickPrompts: DEFAULT_SETTINGS.writingQuickPrompts }
  });
});
api.put('/settings', (req, res) => {
  const patch = { ...req.body };
  if (!patch.apiKey) delete patch.apiKey; // blank = keep the saved key
  for (const k of Object.keys(patch)) {
    if (typeof DEFAULT_SETTINGS[k] !== 'number') continue;
    const n = Number(patch[k]);
    if (patch[k] === '' || !Number.isFinite(n) || n < 0) delete patch[k];
    else patch[k] = n;
  }
  saveSettings(patch);
  res.json({ ok: true });
});
api.get('/models', async (req, res) => res.json(await listModels()));
api.get('/usage', (req, res) => {
  const totals = db
    .prepare('SELECT task, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_tokens) AS cached, SUM(cost) AS cost FROM usage_log GROUP BY task ORDER BY cost DESC')
    .all();
  const byModel = db.prepare('SELECT model, COUNT(*) AS calls, SUM(cost) AS cost FROM usage_log GROUP BY model ORDER BY cost DESC').all();
  const recent = db.prepare('SELECT * FROM usage_log ORDER BY id DESC LIMIT 60').all();
  res.json({ totals, byModel, recent, today: spentToday(), dailyLimit: getSettings().dailySpendLimit });
});
api.delete('/usage', (req, res) => {
  db.prepare('DELETE FROM usage_log').run();
  res.json({ ok: true });
});
api.post('/extract', upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  res.json({ text: await extractText(req.file) });
});

// ---------------------------------------------------------------- chats
function chatPayload(chatId) {
  const chat = getChat(chatId);
  const ids = (t, col) => db.prepare(`SELECT ${col} AS v FROM ${t} WHERE chat_id = ?`).all(chat.id).map((r) => r.v);
  return {
    ...chat,
    params: parseJSON(chat.params, {}),
    options: parseJSON(chat.options, {}),
    pinned: parseJSON(chat.pinned, []),
    map: loadMap(chat),
    base_map: undefined,
    scene: parseJSON(chat.scene, {}),
    lorebook_ids: ids('chat_lorebooks', 'lorebook_id'),
    document_ids: ids('chat_documents', 'document_id'),
    character_ids: db.prepare('SELECT character_id AS v FROM chat_characters WHERE chat_id = ? ORDER BY position').all(chat.id).map((r) => r.v),
    names: (({ user, char }) => ({ user, char }))(chatNames(chat)),
    messages: chatMessages(chat.id).map(publicMessage)
  };
}

api.get('/chats', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.id, c.title, c.mode, c.folder, c.updated_at, c.created_at,
          (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount,
          (SELECT substr(content, 1, 120) FROM messages m WHERE m.chat_id = c.id ORDER BY id DESC LIMIT 1) AS preview,
          (SELECT ch.avatar FROM chat_characters cc JOIN characters ch ON ch.id = cc.character_id WHERE cc.chat_id = c.id ORDER BY cc.position LIMIT 1) AS avatar,
          (SELECT ch.name FROM chat_characters cc JOIN characters ch ON ch.id = cc.character_id WHERE cc.chat_id = c.id ORDER BY cc.position LIMIT 1) AS charName
         FROM chats c ORDER BY c.updated_at DESC, c.id DESC`
      )
      .all()
  );
});

/** Card greetings become the opening AI message (alternate greetings are its swipes). */
function insertGreeting(chatId) {
  const chat = getChat(chatId);
  if (db.prepare('SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1').get(chatId)) return false;
  const names = chatNames(chat);
  const c = names.chars.find((x) => x.first_message?.trim());
  if (!c) return false;
  const swipes = [c.first_message, ...parseJSON(c.alt_greetings, [])].map((g) => macros(g, { user: names.user, char: c.name }).trim()).filter(Boolean);
  db.prepare("INSERT INTO messages (chat_id, role, content, swipes, swipe_meta) VALUES (?, 'assistant', ?, ?, '[]')").run(chatId, swipes[0], JSON.stringify(swipes));
  return true;
}

api.post('/chats', (req, res) => {
  const { mode = 'writing', title, characterIds = [], personaId = null, lorebookIds = [], documentIds = [], system_prompt = '', notes = '' } = req.body;
  if (!['writing', 'roleplay'].includes(mode)) throw httpError(400, 'Mode must be writing or roleplay.');
  const chatId = tx(() => {
    const cid = Number(
      db.prepare('INSERT INTO chats (title, mode, persona_id, system_prompt, notes) VALUES (?, ?, ?, ?, ?)').run(
        title?.trim() || (mode === 'writing' ? 'Untitled draft' : 'New roleplay'), mode, personaId || null, system_prompt, notes
      ).lastInsertRowid
    );
    characterIds.forEach((c, i) => db.prepare('INSERT OR IGNORE INTO chat_characters (chat_id, character_id, position) VALUES (?, ?, ?)').run(cid, id(c), i));
    for (const l of lorebookIds) db.prepare('INSERT OR IGNORE INTO chat_lorebooks (chat_id, lorebook_id) VALUES (?, ?)').run(cid, id(l));
    for (const d of documentIds) db.prepare('INSERT OR IGNORE INTO chat_documents (chat_id, document_id) VALUES (?, ?)').run(cid, id(d));
    return cid;
  });
  if (mode === 'roleplay') insertGreeting(chatId);
  res.json(chatPayload(chatId));
});
api.get('/chats/:id', (req, res) => res.json(chatPayload(id(req.params.id))));
api.put('/chats/:id', (req, res) => {
  const chat = getChat(req.params.id);
  const text = ['title', 'system_prompt', 'author_note', 'model', 'summary', 'manuscript', 'notes', 'folder'];
  const json = ['params', 'options', 'pinned'];
  for (const f of text) if (f in req.body) db.prepare(`UPDATE chats SET ${f} = ? WHERE id = ?`).run(String(req.body[f] ?? ''), chat.id);
  for (const f of json) if (f in req.body) db.prepare(`UPDATE chats SET ${f} = ? WHERE id = ?`).run(JSON.stringify(req.body[f] ?? {}), chat.id);
  if ('author_note_depth' in req.body) db.prepare('UPDATE chats SET author_note_depth = ? WHERE id = ?').run(Math.max(0, Number(req.body.author_note_depth) || 0), chat.id);
  if ('persona_id' in req.body) db.prepare('UPDATE chats SET persona_id = ? WHERE id = ?').run(req.body.persona_id ? id(req.body.persona_id) : null, chat.id);
  if ('mode' in req.body && ['writing', 'roleplay'].includes(req.body.mode)) db.prepare('UPDATE chats SET mode = ? WHERE id = ?').run(req.body.mode, chat.id);
  if ('summary' in req.body && !req.body.summary) db.prepare('UPDATE chats SET summarized_upto = 0 WHERE id = ?').run(chat.id);
  const attach = (key, table, col) => {
    if (!Array.isArray(req.body[key])) return;
    db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(chat.id);
    req.body[key].forEach((v, i) =>
      table === 'chat_characters'
        ? db.prepare('INSERT OR IGNORE INTO chat_characters (chat_id, character_id, position) VALUES (?, ?, ?)').run(chat.id, id(v), i)
        : db.prepare(`INSERT OR IGNORE INTO ${table} (chat_id, ${col}) VALUES (?, ?)`).run(chat.id, id(v))
    );
  };
  tx(() => {
    attach('lorebook_ids', 'chat_lorebooks', 'lorebook_id');
    attach('document_ids', 'chat_documents', 'document_id');
    attach('character_ids', 'chat_characters', 'character_id');
  });
  if (Array.isArray(req.body.character_ids) && getChat(chat.id).mode === 'roleplay') insertGreeting(chat.id);
  if (!('manuscript' in req.body && Object.keys(req.body).length === 1)) db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chat.id);
  res.json(chatPayload(chat.id));
});
api.delete('/chats/:id', (req, res) => {
  db.prepare('DELETE FROM chats WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/chats/:id/branch', (req, res) => res.json({ id: branchChat(id(req.params.id), req.body.messageId) }));
api.post('/chats/:id/greeting', (req, res) => res.json({ added: insertGreeting(id(req.params.id)) }));

api.post('/chats/:id/messages', (req, res) => {
  const chat = getChat(req.params.id);
  const role = ['user', 'system', 'assistant'].includes(req.body.role) ? req.body.role : 'user';
  const content = String(req.body.content ?? '').trim();
  if (!content) throw httpError(400, 'Message is empty');
  const r = db.prepare("INSERT INTO messages (chat_id, role, content, swipes) VALUES (?, ?, ?, ?)").run(chat.id, role, content, JSON.stringify([content]));
  db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chat.id);
  res.json(publicMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid)));
});
api.put('/messages/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(req.params.id));
  if (!m) throw httpError(404, 'Message not found');
  if ('content' in req.body) {
    const swipes = parseJSON(m.swipes, [m.content]);
    swipes[m.swipe_idx] = String(req.body.content);
    db.prepare('UPDATE messages SET content = ?, swipes = ? WHERE id = ?').run(String(req.body.content), JSON.stringify(swipes), m.id);
  }
  if ('hidden' in req.body) db.prepare('UPDATE messages SET hidden = ? WHERE id = ?').run(req.body.hidden ? 1 : 0, m.id);
  res.json(publicMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id)));
});
/** Deletes a message, or with ?after=1 that message and everything after it. Rewinds the map to match. */
api.delete('/messages/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(req.params.id));
  if (!m) throw httpError(404, 'Message not found');
  if (req.query.after === '1') db.prepare('DELETE FROM messages WHERE chat_id = ? AND id >= ?').run(m.chat_id, m.id);
  else db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  const chat = getChat(m.chat_id);
  if (chat.summarized_upto >= m.id && req.query.after === '1') db.prepare("UPDATE chats SET summary = '', summarized_upto = 0 WHERE id = ?").run(chat.id);
  syncTracker(m.chat_id);
  res.json({ ok: true });
});
api.post('/messages/:id/swipe', (req, res) => res.json(selectSwipe(id(req.params.id), req.body.idx)));
api.delete('/messages/:id/swipes/:idx', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(req.params.id));
  if (!m) throw httpError(404, 'Message not found');
  const swipes = parseJSON(m.swipes, [m.content]);
  const sm = parseJSON(m.swipe_meta, []);
  if (swipes.length < 2) throw httpError(400, 'This is the only version left. Delete the message instead.');
  const i = id(req.params.idx);
  swipes.splice(i, 1);
  sm.splice(i, 1);
  db.prepare('UPDATE messages SET swipes = ?, swipe_meta = ? WHERE id = ?').run(JSON.stringify(swipes), JSON.stringify(sm), m.id);
  res.json(selectSwipe(m.id, Math.min(m.swipe_idx, swipes.length - 1)));
});

/** Streams the next AI turn as Server-Sent Events: meta, token, reasoning, done, tracker, error. */
api.post('/chats/:id/generate', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (event, data) => {
    if (!closed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ac = new AbortController();
  // closing the page doesn't stop the AI: only the Stop button does (so a refresh never loses a reply)
  try {
    await generate(id(req.params.id), { kind: req.body.kind, guidance: req.body.guidance || '', signal: ac.signal, emit: send });
  } catch (e) {
    if (e.name !== 'AbortError') send('error', { message: e.message });
    else send('done', { stopped: true });
  }
  res.end();
});
api.post('/chats/:id/stop', (req, res) => {
  stopGeneration(req.params.id);
  res.json({ ok: true });
});
/** The exact prompt the next reply would get (without starting lore timers). */
api.post('/chats/:id/prompt', async (req, res) => {
  const chat = getChat(req.params.id);
  const all = chatMessages(chat.id);
  const kind = req.body.kind || 'reply';
  const history = kind === 'regenerate' && all.length && all[all.length - 1].role === 'assistant' ? all.slice(0, -1) : all;
  const built = await buildPrompt(chat, { history, kind: kind === 'regenerate' ? 'reply' : kind, guidance: req.body.guidance || '', dryRun: true });
  res.json({ messages: built.messages, meta: built.meta });
});

// ---------------------------------------------------------------- roleplay map & scene
api.put('/chats/:id/map', (req, res) => {
  const chat = getChat(req.params.id);
  const map = { ...loadMap(chat), ...req.body.map };
  if (req.body.relayout) {
    for (const l of map.locations) if (req.body.relayout === 'all') { l.x = null; l.y = null; }
  }
  layout(map);
  saveMapEdit(chat.id, map);
  res.json(map);
});
api.post('/chats/:id/map/rebuild', async (req, res) => res.json(await rebuildMap(id(req.params.id), { fresh: !!req.body.fresh })));
api.post('/chats/:id/scene/refresh', async (req, res) => res.json(await refreshScene(id(req.params.id))));

// ---------------------------------------------------------------- lore keeper
api.post('/chats/:id/lore-suggest', async (req, res) => res.json({ entries: await suggestLore(id(req.params.id), req.body.lorebookId) }));

// ---------------------------------------------------------------- export / import chats
api.get('/chats/:id/export', (req, res) => {
  const p = chatPayload(id(req.params.id));
  const safe = p.title.replace(/[^\w -]+/g, '').trim() || 'chat';
  if (req.query.format === 'md') {
    const label = (m) => (m.role === 'user' ? (p.mode === 'writing' ? 'Me' : p.names.user) : m.role === 'system' ? 'Note' : p.mode === 'roleplay' ? p.names.char : 'AI');
    const md = `# ${p.title}\n\n${p.messages.filter((m) => !m.hidden).map((m) => `**${label(m)}:**\n\n${m.content}`).join('\n\n---\n\n')}\n`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.md"`);
    return res.send(md);
  }
  if (req.query.format === 'manuscript') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe} - manuscript.md"`);
    return res.send(p.manuscript || '');
  }
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.inkwell-chat.json"`);
  res.json({ format: 'inkwell-chat', version: 1, chat: { ...p, messages: chatMessages(p.id) } });
});

// ---------------------------------------------------------------- lorebooks
api.get('/lorebooks', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM lore_entries e WHERE e.lorebook_id = b.id) AS entryCount,
          (SELECT COALESCE(SUM(tokens), 0) FROM lore_entries e WHERE e.lorebook_id = b.id) AS tokenCount,
          (SELECT name FROM characters c WHERE c.id = b.character_id) AS characterName
         FROM lorebooks b ORDER BY b.name COLLATE NOCASE`
      )
      .all()
  );
});
api.post('/lorebooks', (req, res) => {
  const r = db.prepare('INSERT INTO lorebooks (name, description) VALUES (?, ?)').run(String(req.body.name || 'New lorebook').trim(), String(req.body.description || ''));
  res.json(db.prepare('SELECT * FROM lorebooks WHERE id = ?').get(r.lastInsertRowid));
});
api.get('/lorebooks/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM lorebooks WHERE id = ?').get(id(req.params.id));
  if (!book) throw httpError(404, 'Lorebook not found');
  const entries = db.prepare('SELECT * FROM lore_entries WHERE lorebook_id = ? ORDER BY category, title COLLATE NOCASE').all(book.id).map(publicEntry);
  res.json({ ...book, entries });
});
api.put('/lorebooks/:id', (req, res) => {
  const b = req.body;
  const cur = db.prepare('SELECT * FROM lorebooks WHERE id = ?').get(id(req.params.id));
  if (!cur) throw httpError(404, 'Lorebook not found');
  const optNum = (v, d) => (v === '' || v === null ? null : v === undefined ? d : Math.max(0, Number(v) || 0));
  db.prepare('UPDATE lorebooks SET name = ?, description = ?, scan_depth = ?, token_budget = ?, recursive = ? WHERE id = ?').run(
    String(b.name ?? cur.name), String(b.description ?? cur.description), optNum(b.scan_depth, cur.scan_depth), optNum(b.token_budget, cur.token_budget), b.recursive === undefined ? cur.recursive : b.recursive ? 1 : 0, cur.id
  );
  res.json({ ok: true });
});
api.delete('/lorebooks/:id', (req, res) => {
  db.prepare('DELETE FROM lorebooks WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/lorebooks/:id/entries', (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [{ title: 'New entry', keys: [], content: '', ...req.body }];
  const book = id(req.params.id);
  const before = db.prepare('SELECT MAX(id) AS m FROM lore_entries').get().m || 0;
  insertEntries(book, list);
  res.json(db.prepare('SELECT * FROM lore_entries WHERE lorebook_id = ? AND id > ? ORDER BY id').all(book, before).map(publicEntry));
});
api.put('/entries/:id', (req, res) => res.json(updateEntry(id(req.params.id), req.body)));
api.delete('/entries/:id', (req, res) => {
  db.prepare('DELETE FROM lore_entries WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
/** Import SillyTavern World Info / character-card lorebooks. Each file becomes a book unless ?into=<id>. */
api.post('/lorebooks/import', upload.array('files', 100), (req, res) => {
  const results = [];
  for (const f of req.files || []) {
    const isPng = f.originalname.toLowerCase().endsWith('.png');
    const json = isPng ? readPngCard(f.buffer) : f.buffer.toString('utf8');
    const entries = parseSillyTavernLorebook(json);
    if (!entries) { results.push({ file: f.originalname, error: 'No lorebook found in this file.' }); continue; }
    let bookId = req.query.into ? id(req.query.into) : null;
    if (!bookId) {
      const parsed = typeof json === 'string' ? parseJSON(json, {}) : json;
      const name = parsed?.name || parsed?.data?.character_book?.name || parsed?.data?.name || f.originalname.replace(/\.(json|png)$/i, '');
      bookId = Number(db.prepare('INSERT INTO lorebooks (name, description) VALUES (?, ?)').run(name, parsed?.description || '').lastInsertRowid);
    }
    results.push({ file: f.originalname, lorebookId: bookId, ...importEntries(bookId, entries) });
  }
  res.json(results);
});
api.get('/lorebooks/:id/export', (req, res) => {
  const data = exportSillyTavern(id(req.params.id));
  res.setHeader('Content-Disposition', `attachment; filename="${(data.name || 'lorebook').replace(/[^\w -]+/g, '').trim() || 'lorebook'}.json"`);
  res.json(data);
});
/** Shows which entries a piece of text would trigger (the lorebook tester). */
api.post('/lorebooks/test', (req, res) => {
  const ids = (req.body.lorebookIds || []).map(id);
  if (!ids.length) return res.json({ trace: [], tokens: 0 });
  const entries = db
    .prepare(
      `SELECT e.*, b.name AS book_name, b.scan_depth AS book_scan_depth, b.recursive AS book_recursive, b.token_budget AS book_budget
       FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id WHERE e.enabled = 1 AND b.id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids);
  const r = activateLore({ entries, recent: [String(req.body.text || '')], random: () => 0 });
  res.json({ trace: r.trace, tokens: r.tokens });
});

// ---------------------------------------------------------------- documents
api.get('/documents', (req, res) => res.json(db.prepare('SELECT id, name, chars, tokens, chunks, created_at FROM documents ORDER BY id DESC').all()));
api.post('/documents', upload.array('files', 50), async (req, res) => {
  const added = [];
  for (const f of req.files || []) added.push(addDocument(f.originalname, await extractText(f)));
  if (req.body?.text) added.push(addDocument(String(req.body.name || 'Pasted text'), req.body.text));
  if (!added.length) throw httpError(400, 'No file or text was given.');
  if (req.query.chat) for (const d of added) db.prepare('INSERT OR IGNORE INTO chat_documents (chat_id, document_id) VALUES (?, ?)').run(id(req.query.chat), d.id);
  res.json(added);
});
api.get('/documents/search', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  res.json(searchForUser(ids.length ? ids : db.prepare('SELECT id FROM documents').all().map((d) => d.id), String(req.query.q || '')));
});
api.get('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id(req.params.id));
  if (!d) throw httpError(404, 'Document not found');
  res.json({ ...d, text: d.text.slice(0, 60000), truncated: d.text.length > 60000 });
});
api.get('/documents/:id/chunks/:idx', (req, res) => res.json(getChunk(id(req.params.id), id(req.params.idx)) || null));
api.put('/documents/:id', (req, res) => {
  if (req.body.name) db.prepare('UPDATE documents SET name = ? WHERE id = ?').run(String(req.body.name), id(req.params.id));
  res.json({ ok: true });
});
api.delete('/documents/:id', (req, res) => {
  deleteDocument(id(req.params.id));
  res.json({ ok: true });
});
api.get('/documents/:id/compile/estimate', async (req, res) => res.json(await estimateCompile(id(req.params.id), String(req.query.instructions || ''))));
api.post('/documents/:id/compile', (req, res) => {
  let bookId = req.body.lorebookId ? id(req.body.lorebookId) : null;
  if (!bookId) {
    const d = db.prepare('SELECT name FROM documents WHERE id = ?').get(id(req.params.id));
    if (!d) throw httpError(404, 'Document not found');
    bookId = Number(db.prepare('INSERT INTO lorebooks (name, description) VALUES (?, ?)').run(`${d.name.replace(/\.\w+$/, '')} (compiled)`, `Compiled from ${d.name}`).lastInsertRowid);
  }
  res.json({ ...startCompile(id(req.params.id), bookId, String(req.body.instructions || '')), lorebookId: bookId });
});
api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw httpError(404, 'Job not found');
  res.json(job);
});

// ---------------------------------------------------------------- characters & personas
const CHAR_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_message', 'example_dialogue', 'system_prompt', 'post_history', 'creator_notes', 'color'];
const publicChar = (c) => ({
  ...c,
  alt_greetings: parseJSON(c.alt_greetings, []),
  tags: parseJSON(c.tags, []),
  lorebook_id: db.prepare('SELECT id FROM lorebooks WHERE character_id = ?').get(c.id)?.id || null,
  tokens: estimateTokens([c.description, c.personality, c.scenario, c.example_dialogue].join('\n'))
});

api.get('/characters', (req, res) => {
  const kind = req.query.kind;
  const rows = kind ? db.prepare('SELECT * FROM characters WHERE kind = ? ORDER BY name COLLATE NOCASE').all(kind) : db.prepare('SELECT * FROM characters ORDER BY kind, name COLLATE NOCASE').all();
  res.json(rows.map(publicChar));
});
api.post('/characters', (req, res) => {
  const b = req.body;
  const r = db
    .prepare(`INSERT INTO characters (kind, ${CHAR_FIELDS.join(', ')}, alt_greetings, tags) VALUES (?, ${CHAR_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
    .run(b.kind === 'persona' ? 'persona' : 'character', ...CHAR_FIELDS.map((f) => (f === 'color' ? b.color || pickColor() : String(b[f] ?? (f === 'name' ? 'Unnamed' : '')))), JSON.stringify(b.alt_greetings || []), JSON.stringify(b.tags || []));
  res.json(publicChar(db.prepare('SELECT * FROM characters WHERE id = ?').get(r.lastInsertRowid)));
});
api.get('/characters/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (!c) throw httpError(404, 'Character not found');
  res.json(publicChar(c));
});
api.put('/characters/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (!c) throw httpError(404, 'Character not found');
  for (const f of CHAR_FIELDS) if (f in req.body) db.prepare(`UPDATE characters SET ${f} = ? WHERE id = ?`).run(String(req.body[f] ?? ''), c.id);
  if (Array.isArray(req.body.alt_greetings)) db.prepare('UPDATE characters SET alt_greetings = ? WHERE id = ?').run(JSON.stringify(req.body.alt_greetings.filter((g) => String(g).trim())), c.id);
  if (Array.isArray(req.body.tags)) db.prepare('UPDATE characters SET tags = ? WHERE id = ?').run(JSON.stringify(req.body.tags), c.id);
  res.json(publicChar(db.prepare('SELECT * FROM characters WHERE id = ?').get(c.id)));
});
api.delete('/characters/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (c?.avatar) fs.rm(path.join(avatarDir, c.avatar), () => {});
  db.prepare('DELETE FROM lorebooks WHERE character_id = ?').run(id(req.params.id));
  db.prepare('DELETE FROM characters WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});

function saveAvatar(buffer, ext) {
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(avatarDir, name), buffer);
  return name;
}

/** Import SillyTavern / Chub / V2 / V3 character cards (.png or .json), with their embedded lorebooks. */
api.post('/characters/import', upload.array('files', 50), (req, res) => {
  const results = [];
  for (const f of req.files || []) {
    const isPng = f.originalname.toLowerCase().endsWith('.png');
    const json = isPng ? readPngCard(f.buffer) : parseJSON(f.buffer.toString('utf8'), null);
    const card = parseCharacterCard(json);
    if (!card) { results.push({ file: f.originalname, error: 'Not a character card.' }); continue; }
    const kind = req.query.kind === 'persona' ? 'persona' : 'character';
    const ch = card.character;
    const r = db
      .prepare(`INSERT INTO characters (kind, name, description, personality, scenario, first_message, alt_greetings, example_dialogue, system_prompt, post_history, creator_notes, tags, avatar, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, ch.name, ch.description, ch.personality, ch.scenario, ch.first_message, JSON.stringify(ch.alt_greetings), ch.example_dialogue, ch.system_prompt, ch.post_history, ch.creator_notes, JSON.stringify(ch.tags), isPng ? saveAvatar(f.buffer, 'png') : '', pickColor());
    const charId = Number(r.lastInsertRowid);
    let lore = 0;
    const entries = card.book ? parseSillyTavernLorebook({ entries: card.book.entries || [] }) : null;
    if (entries?.length) {
      const bookId = Number(db.prepare('INSERT INTO lorebooks (name, description, character_id) VALUES (?, ?, ?)').run(card.book.name || `${ch.name}'s lore`, `Embedded in ${ch.name}'s card`, charId).lastInsertRowid);
      lore = importEntries(bookId, entries).imported;
    }
    results.push({ file: f.originalname, id: charId, name: ch.name, loreEntries: lore });
  }
  res.json(results);
});
api.get('/characters/:id/export', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (!c) throw httpError(404, 'Character not found');
  const book = db.prepare('SELECT id FROM lorebooks WHERE character_id = ?').get(c.id);
  const card = toCharacterCard(c, book ? toCharacterBookEntries(book.id) : null);
  const safe = c.name.replace(/[^\w -]+/g, '').trim() || 'character';
  if (c.avatar?.endsWith('.png') && req.query.format !== 'json') {
    const png = fs.readFileSync(path.join(avatarDir, c.avatar));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.png"`);
    return res.send(writePngCard(png, card));
  }
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
  res.json(card);
});
api.post('/characters/:id/avatar', upload.single('file'), (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (!c || !req.file) throw httpError(400, 'Missing character or image');
  const ext = (req.file.originalname.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
  if (c.avatar) fs.rm(path.join(avatarDir, c.avatar), () => {});
  db.prepare('UPDATE characters SET avatar = ? WHERE id = ?').run(saveAvatar(req.file.buffer, ext), c.id);
  res.json(publicChar(db.prepare('SELECT * FROM characters WHERE id = ?').get(c.id)));
});
api.delete('/characters/:id/avatar', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (c?.avatar) fs.rm(path.join(avatarDir, c.avatar), () => {});
  db.prepare("UPDATE characters SET avatar = '' WHERE id = ?").run(id(req.params.id));
  res.json({ ok: true });
});
/** A lorebook just for this character (travels with its card on export). */
api.post('/characters/:id/lorebook', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(req.params.id));
  if (!c) throw httpError(404, 'Character not found');
  const existing = db.prepare('SELECT id FROM lorebooks WHERE character_id = ?').get(c.id);
  if (existing) return res.json({ id: existing.id });
  res.json({ id: Number(db.prepare('INSERT INTO lorebooks (name, description, character_id) VALUES (?, ?, ?)').run(`${c.name}'s lore`, `Travels with ${c.name}'s card`, c.id).lastInsertRowid) });
});

// ---------------------------------------------------------------- full backup
api.get('/backup', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="inkwell-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(exportAll());
});
api.post('/backup', upload.single('file'), (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  const data = parseJSON(req.file.buffer.toString('utf8'), null);
  if (!data) throw httpError(400, "That file isn't valid JSON.");
  res.json(importAll(data));
});

app.use('/avatars', express.static(avatarDir, { maxAge: '30d', immutable: true }));
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status >= 500 || !err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------------------------------------------------------------- client
const port = Number(process.env.PORT) || 5180;
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve('client/dist');
  if (!fs.existsSync(dist)) {
    console.error('client/dist not found. Run "npm run build" first, or use "npm run dev".');
    process.exit(1);
  }
  app.use(express.static(dist));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Inkwell running at http://localhost:${port}${host === '127.0.0.1' ? '' : ` (listening on ${host})`}`));
