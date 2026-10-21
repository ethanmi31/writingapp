import { db, getSettings, parseJSON, tx } from './db.js';
import { buildPrompt, getChat, chatOptions, chatNames, macros } from './context.js';
import { commitTimers } from './lorebook.js';
import { stream, complete, completeJSON, httpError } from './openrouter.js';
import { updateMap, simplifyScene, saveSnapshot, rewind, loadMap, emptyMap } from './tracker.js';

export const chatMessages = (chatId) => db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id').all(chatId);

export function publicMessage(m) {
  return {
    ...m,
    swipes: parseJSON(m.swipes, []),
    swipe_meta: undefined,
    meta: parseJSON(m.meta, {}),
    hidden: !!m.hidden
  };
}

/** The user's find/replace rules (Settings → Output rules), applied to every AI reply. */
export function applyRegexRules(text) {
  let out = text;
  for (const r of getSettings().regexRules || []) {
    if (!r?.enabled || !r.find) continue;
    try {
      out = out.replace(new RegExp(r.find, (r.flags || 'g').replace(/[^gimsuy]/g, '')), r.replace ?? '');
    } catch {}
  }
  return out;
}

/** A reply cut off by the token limit ends mid-word: trim back to the last full sentence when that loses little. */
function toLastSentence(text) {
  const m = text.match(/^[\s\S]*[.!?…"”*)\]](?=\s|$)/);
  return m && m[0].length > text.length * 0.6 ? m[0].trimEnd() : text.trimEnd();
}

/** Strips a "Name:" label the model sometimes puts in front of its reply. */
function stripLabel(text, names) {
  const labels = ['Narrator', 'Assistant', 'AI', names.char].filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`^\\s*\\**(?:${labels.join('|')})\\**\\s*:\\s*`, 'i'), '');
}

/** Cuts the reply where the model starts writing the player's lines in roleplay ("\nAlex: ..."). */
function cutPlayerLines(text, user) {
  if (!user) return text;
  const cut = text.search(new RegExp(`\\n\\s*\\**${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\**\\s*:`, 'i'));
  return cut > 0 ? text.slice(0, cut).trimEnd() : text;
}

const running = new Map(); // chatId -> AbortController (one generation per chat at a time)

/**
 * Generates the next AI turn and streams it.
 *  kind: reply (new message) | regenerate (new swipe of the last AI message) | continue (extend it) | impersonate (draft the user's turn)
 * events: meta, token, reasoning, done, tracker
 */
export async function generate(chatId, { kind = 'reply', guidance = '', signal, emit = () => {} }) {
  const chat = getChat(chatId);
  const s = getSettings();
  const opt = chatOptions(chat);
  const rp = chat.mode === 'roleplay';
  const all = chatMessages(chat.id);
  const last = all[all.length - 1];

  let history = all;
  let target = null;
  if (kind === 'regenerate' || kind === 'continue') {
    if (!last || last.role !== 'assistant') throw httpError(400, kind === 'continue' ? 'There is no AI message at the end to continue.' : 'The last message is not from the AI.');
    target = last;
    if (kind === 'regenerate') history = all.filter((m) => m.id < target.id);
  }
  if (rp && kind === 'regenerate') rewind(chat.id, target.id);

  running.get(chat.id)?.abort();
  const ac = new AbortController();
  running.set(chat.id, ac);
  const stop = AbortSignal.any([ac.signal, ...(signal ? [signal] : [])]);

  try {
    const fresh = getChat(chat.id); // the rewind may have changed the map
    const built = await buildPrompt(fresh, { history, kind, guidance });
    const model = chat.model || (rp ? s.roleplayModel : s.writingModel);
    emit('meta', { ...built.meta, model, kind, targetId: target?.id || null });

    const params = { temperature: s.temperature, topP: s.topP, minP: s.minP, topK: s.topK, frequencyPenalty: s.frequencyPenalty, presencePenalty: s.presencePenalty, repetitionPenalty: s.repetitionPenalty, ...parseJSON(chat.params, {}) };
    const result = await stream({
      task: kind === 'impersonate' ? 'impersonate' : rp ? 'roleplay' : 'writing',
      model,
      messages: built.messages,
      maxTokens: kind === 'impersonate' ? Math.min(400, built.replyTokens) : built.replyTokens,
      params,
      signal: stop,
      onToken: (t) => emit('token', t),
      onReasoning: (t) => emit('reasoning', t)
    });
    const stopped = stop.aborted;
    if (!s.showReasoning) result.reasoning = '';
    let text = stripLabel(result.text, built.names);
    if (rp) text = cutPlayerLines(text, built.names.user);
    if (result.finish === 'length' && kind !== 'continue') text = toLastSentence(text);
    text = applyRegexRules(text);
    if (!text.trim()) {
      if (stopped) return { stopped: true };
      throw httpError(502, 'The reply was empty after cleanup. Try regenerating.');
    }

    if (kind === 'impersonate') {
      emit('done', { impersonation: text.trim() });
      return;
    }

    const meta = { ...built.meta, model: result.model || model, finish: stopped ? 'stopped' : result.finish };
    let message;
    if (kind === 'reply') {
      const id = Number(
        db.prepare("INSERT INTO messages (chat_id, role, content, swipes, swipe_idx, swipe_meta, reasoning, meta) VALUES (?, 'assistant', ?, ?, 0, ?, ?, ?)").run(
          chat.id, text.trim(), JSON.stringify([text.trim()]), JSON.stringify([{ meta, reasoning: result.reasoning }]), result.reasoning || '', JSON.stringify(meta)
        ).lastInsertRowid
      );
      message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    } else if (kind === 'regenerate') {
      const swipes = parseJSON(target.swipes, [target.content]);
      const sm = parseJSON(target.swipe_meta, []);
      swipes.push(text.trim());
      sm[swipes.length - 1] = { meta, reasoning: result.reasoning };
      db.prepare('UPDATE messages SET content = ?, swipes = ?, swipe_idx = ?, swipe_meta = ?, reasoning = ?, meta = ? WHERE id = ?').run(
        text.trim(), JSON.stringify(swipes), swipes.length - 1, JSON.stringify(sm), result.reasoning || '', JSON.stringify(meta), target.id
      );
      message = db.prepare('SELECT * FROM messages WHERE id = ?').get(target.id);
    } else {
      // continue: glue the new text on, with a space unless it starts a new paragraph or punctuation
      const joined = /^[\s,.;:!?…'"’”)\]-]/.test(text) || /\s$/.test(target.content) ? target.content + text : `${target.content} ${text}`;
      const swipes = parseJSON(target.swipes, [target.content]);
      swipes[target.swipe_idx] = joined.trim();
      db.prepare('UPDATE messages SET content = ?, swipes = ?, reasoning = ? WHERE id = ?').run(joined.trim(), JSON.stringify(swipes), [target.reasoning, result.reasoning].filter(Boolean).join('\n\n'), target.id);
      message = db.prepare('SELECT * FROM messages WHERE id = ?').get(target.id);
    }
    db.prepare('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chat.id);
    if (kind !== 'continue') commitTimers(chat.id, built.lore.chosen, built.turn);
    emit('done', publicMessage(message));

    // background upkeep: rolling memory, and in roleplay the map + scene card (streamed back when ready)
    if (built.unsummarized.length) summarize(chat.id, built.unsummarized).catch((e) => console.error('summary failed:', e.message));
    if (rp && !stopped) {
      if (kind === 'continue') rewind(chat.id, message.id);
      await track(chat.id, message.id, emit).catch((e) => emit('tracker', { error: e.message }));
    }
  } finally {
    if (running.get(chat.id) === ac) running.delete(chat.id);
  }
}

export function stopGeneration(chatId) {
  running.get(Number(chatId))?.abort();
}

/** Map keeper, then scene simplifier, for the AI message `messageId`. */
export async function track(chatId, messageId, emit = () => {}) {
  const s = getSettings();
  const chat = getChat(chatId);
  const opt = chatOptions(chat);
  const trackerOn = opt.trackerEnabled ?? s.trackerEnabled;
  const simplifierOn = opt.simplifierEnabled ?? s.simplifierEnabled;
  if (!trackerOn && !simplifierOn) return;
  const { user, persona } = chatNames(chat);
  emit('tracker', { status: 'running' });
  let map = loadMap(chat);
  let log = [];
  if (trackerOn) {
    ({ map, log } = await updateMap(chat, messageId, { playerName: user }));
    db.prepare('UPDATE chats SET map = ? WHERE id = ?').run(JSON.stringify(map), chatId);
  }
  let scene = parseJSON(chat.scene, {});
  if (simplifierOn) {
    try {
      scene = await simplifyScene(chat, messageId, { map, playerName: user, persona });
      db.prepare('UPDATE chats SET scene = ? WHERE id = ?').run(JSON.stringify(scene), chatId);
    } catch (e) {
      emit('tracker', { error: `Scene simplifier: ${e.message}` });
    }
  }
  saveSnapshot(chatId, messageId, map, scene);
  // remember the tracker state per swipe, and a one-line TL;DR on the message itself
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (msg) {
    const sm = parseJSON(msg.swipe_meta, []);
    sm[msg.swipe_idx] = { ...(sm[msg.swipe_idx] || {}), map, scene };
    const meta = { ...parseJSON(msg.meta, {}), tldr: scene.happening || '', mapLog: log };
    db.prepare('UPDATE messages SET swipe_meta = ?, meta = ? WHERE id = ?').run(JSON.stringify(sm), JSON.stringify(meta), messageId);
  }
  emit('tracker', { status: 'done', map, scene, log, messageId, tldr: scene.happening || '' });
}

/** Makes the chat's map/scene match the newest remaining snapshot (after deletes). */
export function syncTracker(chatId) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE chat_id = ? ORDER BY message_id DESC LIMIT 1').get(chatId);
  if (snap) db.prepare('UPDATE chats SET map = ?, scene = ? WHERE id = ?').run(snap.map, snap.scene, chatId);
  else db.prepare("UPDATE chats SET map = base_map, scene = '{}' WHERE id = ?").run(chatId);
}

/** Switches which version (swipe) of an AI message is shown — and with it that version's map and scene. */
export function selectSwipe(messageId, idx) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!m) throw httpError(404, 'Message not found');
  const swipes = parseJSON(m.swipes, [m.content]);
  const i = Math.max(0, Math.min(swipes.length - 1, Number(idx)));
  const sm = parseJSON(m.swipe_meta, [])[i] || {};
  db.prepare('UPDATE messages SET content = ?, swipe_idx = ?, reasoning = ?, meta = ? WHERE id = ?').run(swipes[i], i, sm.reasoning || '', JSON.stringify({ ...(sm.meta || {}), tldr: sm.scene?.happening || '' }), m.id);
  if (sm.map) {
    saveSnapshot(m.chat_id, m.id, sm.map, sm.scene);
    syncTracker(m.chat_id);
  }
  return publicMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id));
}

const summarizing = new Set();

/** Folds messages that no longer fit in the context window into the chat's rolling summary. */
async function summarize(chatId, msgs) {
  if (summarizing.has(chatId) || !msgs.length) return;
  summarizing.add(chatId);
  try {
    const chat = getChat(chatId);
    const { user } = chatNames(chat);
    const rp = chat.mode === 'roleplay';
    const fold = msgs.filter((m) => m.id > (chat.summarized_upto || 0));
    if (!fold.length) return;
    const summary = await complete({
      task: 'summary',
      maxTokens: 900,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: rp
            ? 'Update the running summary of an interactive story so it can replace the old messages. Keep: key events in order, decisions, promises, secrets revealed, relationship changes, injuries, items gained or lost, where people went, unresolved threads. Max 400 words, past tense, third person. Return only the summary.'
            : 'Update the running summary of a writing session between an author and their AI writing partner so it can replace the old messages. Keep: every standing instruction or preference the author gave (style, POV, tense, things to avoid), decisions about plot and characters, what was drafted, open questions. Max 400 words. Return only the summary.'
        },
        {
          role: 'user',
          content: `CURRENT SUMMARY:\n${chat.summary || '(none yet)'}\n\nMESSAGES TO FOLD IN:\n${fold.map((m) => `${m.role === 'user' ? user : m.role === 'system' ? 'OOC' : rp ? 'Narrator' : 'AI'}: ${m.content}`).join('\n\n')}`
        }
      ]
    });
    db.prepare('UPDATE chats SET summary = ?, summarized_upto = ? WHERE id = ?').run(summary.trim(), fold[fold.length - 1].id, chatId);
  } finally {
    summarizing.delete(chatId);
  }
}

/** Builds (or rebuilds) the roleplay map from the story so far — or from the scenario if nothing happened yet. */
export async function rebuildMap(chatId, { fresh = false } = {}) {
  const chat = getChat(chatId);
  const { user, chars, persona } = chatNames(chat);
  if (fresh) {
    chat.map = JSON.stringify(emptyMap());
  }
  const lastAi = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' AND hidden = 0 ORDER BY id DESC LIMIT 1").get(chatId);
  const story = [
    ...chars.map((c) => macros(c.scenario, { user, char: c.name })),
    chat.notes,
    persona?.description && `${user}: ${persona.description}`
  ].filter((x) => x?.trim()).join('\n\n');
  const { map, log } = await updateMap(chat, lastAi?.id || 0, { playerName: user, rebuild: true, story: story || 'An empty starting point.' });
  db.prepare('UPDATE chats SET map = ? WHERE id = ?').run(JSON.stringify(map), chatId);
  if (lastAi) {
    const snap = db.prepare('SELECT scene FROM snapshots WHERE message_id = ?').get(lastAi.id);
    saveSnapshot(chatId, lastAi.id, map, parseJSON(snap?.scene, {}));
  } else {
    db.prepare('UPDATE chats SET base_map = ? WHERE id = ?').run(JSON.stringify(map), chatId);
  }
  return { map, log };
}

/** Saves a hand-edited map (and keeps it when rewinding to this point). */
export function saveMapEdit(chatId, map) {
  const lastSnap = db.prepare('SELECT message_id FROM snapshots WHERE chat_id = ? ORDER BY message_id DESC LIMIT 1').get(chatId);
  tx(() => {
    db.prepare('UPDATE chats SET map = ? WHERE id = ?').run(JSON.stringify(map), chatId);
    if (lastSnap) db.prepare('UPDATE snapshots SET map = ? WHERE message_id = ?').run(JSON.stringify(map), lastSnap.message_id);
    else db.prepare('UPDATE chats SET base_map = ? WHERE id = ?').run(JSON.stringify(map), chatId);
  });
}

/** Re-runs the scene simplifier for the latest AI message (e.g. after editing it). */
export async function refreshScene(chatId) {
  const lastAi = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' AND hidden = 0 ORDER BY id DESC LIMIT 1").get(chatId);
  if (!lastAi) throw httpError(400, 'Nothing has happened yet to simplify.');
  const events = [];
  await track(chatId, lastAi.id, (event, data) => events.push(data));
  const err = events.find((e) => e.error);
  if (err) throw httpError(502, err.error);
  return events[events.length - 1];
}

/**
 * Lore keeper: reads recent messages and proposes new lorebook entries (or additions to existing ones) for facts
 * the story established that the lorebooks don't have yet. Nothing is saved until the user accepts.
 */
export async function suggestLore(chatId, lorebookId) {
  const chat = getChat(chatId);
  const msgs = chatMessages(chatId).filter((m) => !m.hidden).slice(-24);
  if (!msgs.length) throw httpError(400, 'Nothing in this chat yet.');
  const existing = db
    .prepare(`SELECT e.title, e.keys FROM lore_entries e WHERE e.lorebook_id IN (SELECT lorebook_id FROM chat_lorebooks WHERE chat_id = ?) OR e.lorebook_id = ?`)
    .all(chatId, lorebookId || 0);
  const { user } = chatNames(chat);
  const out = await completeJSON({
    task: 'lore-keeper',
    expect: 'entries',
    maxTokens: 3000,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `You are the LORE KEEPER for a ${chat.mode === 'roleplay' ? 'roleplay' : 'novel'} in progress. Read the recent story and propose lorebook entries for NEW, lasting facts it established that the existing entries don't cover: new characters (with appearance, personality, relationships), places, items, factions, events, and important changes to existing subjects.
Skip trivia and anything temporary. Never invent facts.
Return ONLY JSON: {"entries":[{"title":string,"category":"Character|Location|Item|Faction|Event|Concept","keys":[2-5 specific triggers],"content":"dense third-person facts, 40-150 words","update_of":"title of an existing entry this extends, or ''"}]}`
      },
      {
        role: 'user',
        content: `EXISTING ENTRIES:\n${existing.map((e) => `- ${e.title} (${parseJSON(e.keys, []).join(', ')})`).join('\n') || '(none)'}\n\n${chat.mode === 'writing' && chat.manuscript ? `MANUSCRIPT (latest part):\n${chat.manuscript.slice(-8000)}\n\n` : ''}RECENT MESSAGES:\n${msgs.map((m) => `${m.role === 'user' ? user : 'AI'}: ${m.content}`).join('\n\n').slice(-24000)}`
      }
    ]
  });
  return (out.entries || []).filter((e) => e?.content && e?.title).slice(0, 12);
}

/** Copies a chat up to (and including) a message into a new chat: a branch you can take somewhere else. */
export function branchChat(chatId, messageId) {
  const chat = getChat(chatId);
  const msgs = chatMessages(chatId).filter((m) => m.id <= Number(messageId));
  return tx(() => {
    const cols = ['mode', 'system_prompt', 'author_note', 'author_note_depth', 'model', 'params', 'options', 'persona_id', 'manuscript', 'notes', 'pinned', 'base_map', 'folder'];
    const id = Number(
      db.prepare(`INSERT INTO chats (title, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(`${chat.title} (branch)`, ...cols.map((c) => chat[c])).lastInsertRowid
    );
    for (const t of ['chat_lorebooks', 'chat_documents']) {
      const col = t === 'chat_lorebooks' ? 'lorebook_id' : 'document_id';
      db.prepare(`INSERT INTO ${t} (chat_id, ${col}) SELECT ?, ${col} FROM ${t} WHERE chat_id = ?`).run(id, chatId);
    }
    db.prepare('INSERT INTO chat_characters (chat_id, character_id, position) SELECT ?, character_id, position FROM chat_characters WHERE chat_id = ?').run(id, chatId);
    const ins = db.prepare('INSERT INTO messages (chat_id, role, content, swipes, swipe_idx, swipe_meta, reasoning, meta, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const snap = db.prepare('SELECT * FROM snapshots WHERE message_id = ?');
    for (const m of msgs) {
      const newId = Number(ins.run(id, m.role, m.content, m.swipes, m.swipe_idx, m.swipe_meta, m.reasoning, m.meta, m.hidden, m.created_at).lastInsertRowid);
      const sn = snap.get(m.id);
      if (sn) saveSnapshot(id, newId, parseJSON(sn.map, {}), parseJSON(sn.scene, {}));
    }
    // the summary only stays valid if it doesn't cover messages past the branch point
    if (chat.summarized_upto && chat.summarized_upto <= Number(messageId)) {
      const lastFolded = msgs.filter((m) => m.id <= chat.summarized_upto).length;
      const newIds = db.prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id').all(id).map((r) => r.id);
      db.prepare('UPDATE chats SET summary = ?, summarized_upto = ? WHERE id = ?').run(chat.summary, newIds[lastFolded - 1] || 0, id);
    }
    syncTracker(id);
    return id;
  });
}
