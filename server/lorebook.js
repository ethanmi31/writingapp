import { db, estimateTokens, getSettings, tx, parseJSON } from './db.js';
import { completeJSON, modelPrice, httpError } from './openrouter.js';

// ---------------------------------------------------------------------------
// Entries: shape, storage, SillyTavern import/export
// ---------------------------------------------------------------------------

const LOGICS = ['and_any', 'not_all', 'not_any', 'and_all']; // index = SillyTavern's selectiveLogic number
const POSITIONS = ['before', 'after', 'an', 'depth'];

const clamp = (n, lo, hi, d) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
};
const keyList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((k) => String(k).trim()).filter(Boolean);
const triState = (v) => (v === null || v === undefined || v === '' ? null : v ? 1 : 0);

/** Any loose entry object (ours, the editor's, or the AI compiler's) → a row ready to store. */
export function normalizeEntry(e = {}) {
  const content = String(e.content ?? '');
  return {
    title: String(e.title ?? '').trim().slice(0, 300),
    keys: JSON.stringify([...new Set(keyList(e.keys))]),
    secondary_keys: JSON.stringify([...new Set(keyList(e.secondary_keys))]),
    logic: LOGICS.includes(e.logic) ? e.logic : 'and_any',
    content,
    category: String(e.category ?? '').trim(),
    enabled: e.enabled === false || e.enabled === 0 ? 0 : 1,
    constant: e.constant ? 1 : 0,
    priority: clamp(e.priority, -1000, 10000, 100),
    position: POSITIONS.includes(e.position) ? e.position : 'before',
    depth: clamp(e.depth, 0, 1000, 4),
    probability: clamp(e.probability, 0, 100, 100),
    case_sensitive: triState(e.case_sensitive),
    whole_words: triState(e.whole_words),
    scan_depth: e.scan_depth === '' || e.scan_depth == null ? null : clamp(e.scan_depth, 0, 1000, null),
    sticky: clamp(e.sticky, 0, 1000, 0),
    cooldown: clamp(e.cooldown, 0, 1000, 0),
    delay: clamp(e.delay, 0, 100000, 0),
    group_name: String(e.group_name ?? '').trim(),
    group_weight: clamp(e.group_weight, 1, 10000, 100),
    group_override: e.group_override ? 1 : 0,
    exclude_recursion: e.exclude_recursion ? 1 : 0,
    prevent_recursion: e.prevent_recursion ? 1 : 0,
    delay_until_recursion: e.delay_until_recursion ? 1 : 0,
    ignore_budget: e.ignore_budget ? 1 : 0,
    modes: ['both', 'writing', 'roleplay'].includes(e.modes) ? e.modes : 'both',
    tokens: estimateTokens(content)
  };
}

const FIELDS = Object.keys(normalizeEntry());

export function insertEntries(lorebookId, entries) {
  const stmt = db.prepare(`INSERT INTO lore_entries (lorebook_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`);
  let n = 0;
  tx(() => {
    for (const raw of entries) {
      const e = normalizeEntry(raw);
      if (!e.content.trim() && !e.title) continue;
      stmt.run(lorebookId, ...FIELDS.map((f) => e[f]));
      n++;
    }
  });
  return n;
}

export function updateEntry(id, patch) {
  const current = db.prepare('SELECT * FROM lore_entries WHERE id = ?').get(id);
  if (!current) throw httpError(404, 'Entry not found');
  const merged = normalizeEntry({ ...publicEntry(current), ...patch });
  db.prepare(`UPDATE lore_entries SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...FIELDS.map((f) => merged[f]), id);
  return publicEntry(db.prepare('SELECT * FROM lore_entries WHERE id = ?').get(id));
}

/** A stored row → what the API returns (arrays and booleans instead of JSON strings and 0/1). */
export function publicEntry(e) {
  const bool = (v) => (v == null ? null : !!v);
  return {
    ...e,
    keys: parseJSON(e.keys, []),
    secondary_keys: parseJSON(e.secondary_keys, []),
    enabled: !!e.enabled,
    constant: !!e.constant,
    case_sensitive: bool(e.case_sensitive),
    whole_words: bool(e.whole_words),
    group_override: !!e.group_override,
    exclude_recursion: !!e.exclude_recursion,
    prevent_recursion: !!e.prevent_recursion,
    delay_until_recursion: !!e.delay_until_recursion,
    ignore_budget: !!e.ignore_budget
  };
}

/**
 * Parses SillyTavern lorebooks: World Info exports ({entries: {"0": {...}}}), character cards with an embedded
 * character_book (V2/V3), or plain arrays. Keeps every activation setting SillyTavern has that we support.
 * Returns null if the JSON is not a lorebook.
 */
export function parseSillyTavernLorebook(input) {
  let json;
  try { json = typeof input === 'string' ? JSON.parse(input) : input; } catch { return null; }
  const book = json?.data?.character_book || json?.character_book || json;
  const raw = Array.isArray(book) ? book : book?.entries;
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const entries = list
    .filter((e) => e && typeof e === 'object' && (e.content || e.key || e.keys))
    .map((e) => {
      const ext = e.extensions || {};
      const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
      // World Info: position 0/1 = before/after the character, 2/3 = author's note, 4 = at depth.
      // Character books: "before_char" / "after_char".
      const pos = pick(e.position, ext.position);
      const position = pos === 4 ? 'depth' : pos === 2 || pos === 3 ? 'an' : pos === 1 || pos === 'after_char' ? 'after' : 'before';
      const logic = pick(e.selectiveLogic, ext.selectiveLogic, 0);
      const useProb = pick(e.useProbability, ext.useProbability, true);
      return {
        title: e.comment || e.name || keyList(e.key ?? e.keys)[0] || 'Entry',
        keys: keyList(e.key ?? e.keys),
        secondary_keys: e.selective === false ? [] : keyList(e.keysecondary ?? e.secondary_keys),
        logic: LOGICS[logic] || 'and_any',
        content: String(e.content || ''),
        category: String(e.category || ext.category || ''),
        enabled: !(e.disable === true || e.enabled === false),
        constant: !!e.constant,
        priority: pick(e.order, e.insertion_order, e.priority, 100),
        position,
        depth: pick(e.depth, ext.depth, 4),
        probability: useProb ? pick(e.probability, ext.probability, 100) : 100,
        case_sensitive: pick(e.caseSensitive, ext.case_sensitive, e.case_sensitive, null),
        whole_words: pick(e.matchWholeWords, ext.match_whole_words, null),
        scan_depth: pick(e.scanDepth, ext.scan_depth, null),
        sticky: pick(e.sticky, ext.sticky, 0),
        cooldown: pick(e.cooldown, ext.cooldown, 0),
        delay: pick(e.delay, ext.delay, 0),
        group_name: String(pick(e.group, ext.group, '') || ''),
        group_weight: pick(e.groupWeight, ext.group_weight, 100),
        group_override: pick(e.groupOverride, ext.group_override, false),
        exclude_recursion: pick(e.excludeRecursion, ext.exclude_recursion, false),
        prevent_recursion: pick(e.preventRecursion, ext.prevent_recursion, false),
        delay_until_recursion: !!pick(e.delayUntilRecursion, ext.delay_until_recursion, false),
        ignore_budget: pick(e.ignoreBudget, ext.ignore_budget, false)
      };
    })
    .filter((e) => e.content.trim());
  return entries.length || list.length === 0 ? entries : null;
}

/** Exports a lorebook in SillyTavern's World Info format (importable there unchanged). */
export function exportSillyTavern(lorebookId) {
  const book = db.prepare('SELECT * FROM lorebooks WHERE id = ?').get(lorebookId);
  if (!book) throw httpError(404, 'Lorebook not found');
  const rows = db.prepare('SELECT * FROM lore_entries WHERE lorebook_id = ? ORDER BY id').all(lorebookId);
  const entries = {};
  rows.forEach((r, uid) => {
    const e = publicEntry(r);
    entries[uid] = {
      uid,
      key: e.keys,
      keysecondary: e.secondary_keys,
      comment: e.title,
      content: e.content,
      constant: e.constant,
      vectorized: false,
      selective: true,
      selectiveLogic: LOGICS.indexOf(e.logic),
      addMemo: true,
      order: e.priority,
      position: { before: 0, after: 1, an: 3, depth: 4 }[e.position],
      disable: !e.enabled,
      excludeRecursion: e.exclude_recursion,
      preventRecursion: e.prevent_recursion,
      delayUntilRecursion: e.delay_until_recursion,
      probability: e.probability,
      useProbability: true,
      depth: e.depth,
      group: e.group_name,
      groupOverride: e.group_override,
      groupWeight: e.group_weight,
      scanDepth: e.scan_depth,
      caseSensitive: e.case_sensitive,
      matchWholeWords: e.whole_words,
      sticky: e.sticky || null,
      cooldown: e.cooldown || null,
      delay: e.delay || null,
      ignoreBudget: e.ignore_budget,
      role: 0,
      displayIndex: uid
    };
  });
  return { name: book.name, description: book.description, entries };
}

/** Character-book entries (V2 card format) for exporting a character with its lore. */
export function toCharacterBookEntries(lorebookId) {
  return db.prepare('SELECT * FROM lore_entries WHERE lorebook_id = ? ORDER BY id').all(lorebookId).map((r, i) => {
    const e = publicEntry(r);
    return {
      id: i,
      keys: e.keys,
      secondary_keys: e.secondary_keys,
      comment: e.title,
      content: e.content,
      constant: e.constant,
      selective: e.secondary_keys.length > 0,
      insertion_order: e.priority,
      enabled: e.enabled,
      position: e.position === 'after' ? 'after_char' : 'before_char',
      extensions: { depth: e.depth, probability: e.probability, group: e.group_name, sticky: e.sticky, cooldown: e.cooldown, delay: e.delay }
    };
  });
}

/** Imports entries, skipping ones the book already has (same title and content). */
export function importEntries(lorebookId, entries) {
  const existing = new Set(
    db.prepare('SELECT title, content FROM lore_entries WHERE lorebook_id = ?').all(lorebookId).map((e) => `${e.title.toLowerCase()}\u0000${e.content.trim()}`)
  );
  const fresh = entries.filter((e) => !existing.has(`${String(e.title || '').toLowerCase()}\u0000${String(e.content || '').trim()}`));
  insertEntries(lorebookId, fresh);
  return { imported: fresh.length, skipped: entries.length - fresh.length };
}

// ---------------------------------------------------------------------------
// Activation (SillyTavern World Info semantics, plus a few upgrades)
// ---------------------------------------------------------------------------

const matcherCache = new Map();

/**
 * Compiles one trigger key. "/pattern/flags" keys are regular expressions. Plain keys match whole words
 * (Unicode-aware), and with inflections on also match common endings: dragon → dragons, Kael → Kael's.
 */
export function keyMatcher(key, { caseSensitive = false, wholeWords = true, inflections = true } = {}) {
  const cacheKey = `${key}\u0000${caseSensitive}${wholeWords}${inflections}`;
  let re = matcherCache.get(cacheKey);
  if (re !== undefined) return re;
  const rx = key.match(/^\/(.+)\/([a-z]*)$/s);
  try {
    if (rx) {
      re = new RegExp(rx[1], rx[2].replace(/[gy]/g, ''));
    } else {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? 'u' : 'iu';
      if (!wholeWords) {
        re = new RegExp(escaped, flags);
      } else {
        const pre = /^[\p{L}\p{N}_]/u.test(key) ? '(?<![\\p{L}\\p{N}_])' : '';
        const endsInLetter = /\p{L}$/u.test(key);
        const suffix = inflections && endsInLetter ? "(?:'s|’s|s|es|'|’)?" : '';
        const post = /[\p{L}\p{N}_]$/u.test(key) ? '(?![\\p{L}\\p{N}_])' : '';
        re = new RegExp(`${pre}${escaped}${suffix}${post}`, flags);
      }
    }
  } catch {
    re = null; // a broken regex key never matches (the editor flags it)
  }
  if (matcherCache.size > 20000) matcherCache.clear();
  matcherCache.set(cacheKey, re);
  return re;
}

/** Lore entries from every lorebook attached to the chat (plus books embedded in its characters). */
export function chatEntries(chatId, mode) {
  return db
    .prepare(
      `SELECT e.*, b.name AS book_name, b.scan_depth AS book_scan_depth, b.recursive AS book_recursive, b.token_budget AS book_budget
       FROM lore_entries e JOIN lorebooks b ON b.id = e.lorebook_id
       WHERE e.enabled = 1 AND (e.modes = 'both' OR e.modes = ?) AND b.id IN (
         SELECT lorebook_id FROM chat_lorebooks WHERE chat_id = ?
         UNION SELECT l.id FROM lorebooks l JOIN chat_characters cc ON cc.character_id = l.character_id WHERE cc.chat_id = ?
         UNION SELECT l.id FROM lorebooks l JOIN chats c ON c.persona_id = l.character_id WHERE c.id = ?
       )`
    )
    .all(mode, chatId, chatId, chatId);
}

/**
 * Picks the lore entries for this turn.
 *  - recent: chat messages, newest LAST (only their text is used)
 *  - extra: always-scanned text that isn't chat (current map location, people present, manuscript tail)
 *  - turn: message count, for sticky / cooldown / delay
 * Returns entries grouped by insertion position plus a trace of why each one fired (for the inspector).
 */
export function activateLore({ entries, recent = [], extra = '', turn = 0, timers = new Map(), budget, settings = getSettings(), random = Math.random }) {
  budget ??= settings.loreBudget;
  const defaults = {
    caseSensitive: !!settings.caseSensitive,
    wholeWords: settings.wholeWords !== false,
    inflections: settings.matchInflections !== false
  };
  const steps = Math.max(0, Number(settings.recursionSteps ?? 3));
  const bufferCache = new Map();
  const chatBuffer = (depth) => {
    if (!bufferCache.has(depth)) bufferCache.set(depth, [...recent.slice(depth > 0 ? -depth : recent.length), extra].join('\n\n'));
    return bufferCache.get(depth);
  };
  const opts = (e) => ({
    caseSensitive: e.case_sensitive == null ? defaults.caseSensitive : !!e.case_sensitive,
    wholeWords: e.whole_words == null ? defaults.wholeWords : !!e.whole_words,
    inflections: defaults.inflections
  });
  const firstMatch = (keys, text, o) => keys.find((k) => keyMatcher(k, o)?.test(text));
  const matches = (e, text) => {
    const o = opts(e);
    const primary = parseJSON(e.keys, []);
    const key = firstMatch(primary, text, o);
    if (!key) return null;
    const secondary = parseJSON(e.secondary_keys, []);
    if (!secondary.length) return key;
    const hits = secondary.filter((k) => keyMatcher(k, o)?.test(text)).length;
    const ok = { and_any: hits > 0, and_all: hits === secondary.length, not_any: hits === 0, not_all: hits < secondary.length }[e.logic || 'and_any'];
    return ok ? key : null;
  };

  const active = new Map(); // id -> { e, reason, key, step }
  const blocked = new Set(); // failed a probability roll or lost its group this turn
  const trace = [];
  const groupWinner = new Map();

  // inclusion groups: of the entries that fire together, only one per group is used
  const admit = (batch) => {
    const byGroup = new Map();
    for (const a of batch) {
      if (!a.e.group_name) { active.set(a.e.id, a); continue; }
      for (const g of a.e.group_name.split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(a);
      }
    }
    for (const [g, list] of byGroup) {
      if (groupWinner.has(g)) {
        for (const a of list) if (!active.has(a.e.id)) { blocked.add(a.e.id); trace.push({ id: a.e.id, title: a.e.title, skipped: `lost inclusion group "${g}"` }); }
        continue;
      }
      const forced = list.filter((a) => a.reason === 'sticky');
      const prio = list.filter((a) => a.e.group_override);
      let win;
      if (forced.length) win = forced[0];
      else if (prio.length) win = prio.sort((a, b) => b.e.priority - a.e.priority)[0];
      else {
        const total = list.reduce((s, a) => s + (a.e.group_weight || 100), 0);
        let roll = random() * total;
        win = list.find((a) => (roll -= a.e.group_weight || 100) < 0) || list[list.length - 1];
      }
      groupWinner.set(g, win.e.id);
      if (!blocked.has(win.e.id)) active.set(win.e.id, win);
      for (const a of list) if (a !== win && !active.has(a.e.id)) { blocked.add(a.e.id); trace.push({ id: a.e.id, title: a.e.title, skipped: `lost inclusion group "${g}"` }); }
    }
  };

  const eligible = entries.filter((e) => {
    if (e.delay && turn < e.delay) return false;
    return true;
  });

  // step 0: sticky, constant and chat-triggered entries
  const first = [];
  for (const e of eligible) {
    const t = timers.get(e.id);
    if (t && t.sticky_until > turn) { first.push({ e, reason: 'sticky' }); continue; }
    if (t && t.cooldown_until > turn) continue;
    if (e.constant) { first.push({ e, reason: 'constant' }); continue; }
    if (e.delay_until_recursion) continue;
    const depth = e.scan_depth ?? e.book_scan_depth ?? settings.scanDepth;
    const key = matches(e, chatBuffer(depth));
    if (!key) continue;
    if (e.probability < 100 && random() * 100 >= e.probability) { blocked.add(e.id); trace.push({ id: e.id, title: e.title, skipped: `probability ${e.probability}% roll failed` }); continue; }
    first.push({ e, reason: 'keyword', key });
  }
  admit(first);

  // recursion: text of activated entries can trigger further entries
  let recursionText = '';
  let fresh = [...active.values()];
  for (let step = 1; step <= steps && fresh.length; step++) {
    const added = fresh.filter((a) => !a.e.prevent_recursion && a.e.book_recursive !== 0).map((a) => a.e.content).join('\n');
    if (!added) break;
    recursionText += `\n${added}`;
    const batch = [];
    for (const e of eligible) {
      if (active.has(e.id) || blocked.has(e.id) || e.exclude_recursion || e.book_recursive === 0) continue;
      const t = timers.get(e.id);
      if (t && t.cooldown_until > turn) continue;
      const key = matches(e, recursionText);
      if (!key) continue;
      if (e.probability < 100 && random() * 100 >= e.probability) { blocked.add(e.id); continue; }
      batch.push({ e, reason: 'recursion', key, step });
    }
    admit(batch);
    fresh = batch.filter((a) => active.has(a.e.id));
  }

  // budget: forced entries first, then by priority; per-book budgets apply on top of the global one
  const rank = { sticky: 0, constant: 1, keyword: 2, recursion: 3 };
  const ranked = [...active.values()].sort(
    (a, b) => b.e.ignore_budget - a.e.ignore_budget || rank[a.reason] - rank[b.reason] || b.e.priority - a.e.priority || (a.step || 0) - (b.step || 0)
  );
  const chosen = [];
  let tokens = 0;
  const perBook = new Map();
  for (const a of ranked) {
    const t = a.e.tokens || estimateTokens(a.e.content);
    const bookUsed = perBook.get(a.e.lorebook_id) || 0;
    const overBook = a.e.book_budget && bookUsed + t > a.e.book_budget;
    if (!a.e.ignore_budget && (tokens + t > budget || overBook)) {
      trace.push({ id: a.e.id, title: a.e.title, skipped: overBook ? 'over its lorebook budget' : 'over the lore budget' });
      continue;
    }
    chosen.push(a);
    tokens += t;
    perBook.set(a.e.lorebook_id, bookUsed + t);
  }

  // lower priority first, so the most important entries sit closest to the end of each block
  chosen.sort((a, b) => a.e.priority - b.e.priority);
  const block = (list) => list.map((a) => a.e.content.trim()).filter(Boolean).join('\n\n');
  const at = (pos) => chosen.filter((a) => a.e.position === pos);
  const depthGroups = new Map();
  for (const a of at('depth')) {
    const d = a.e.depth ?? 4;
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d).push(a);
  }

  return {
    before: block(at('before')),
    after: block(at('after')),
    an: block(at('an')),
    depth: [...depthGroups].map(([depth, list]) => ({ depth, text: block(list) })),
    tokens,
    chosen,
    text: block(chosen),
    trace: [
      ...chosen.map((a) => ({ id: a.e.id, title: a.e.title, book: a.e.book_name, reason: a.reason, key: a.key, step: a.step, tokens: a.e.tokens, position: a.e.position })),
      ...trace
    ]
  };
}

/** Starts sticky / cooldown timers for entries that newly fired on this turn. */
export function commitTimers(chatId, chosen, turn) {
  const up = db.prepare(
    `INSERT INTO lore_timers (chat_id, entry_id, sticky_until, cooldown_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, entry_id) DO UPDATE SET sticky_until = excluded.sticky_until, cooldown_until = excluded.cooldown_until`
  );
  for (const a of chosen) {
    if (a.reason === 'sticky') continue;
    const { sticky, cooldown } = a.e;
    if (!sticky && !cooldown) continue;
    up.run(chatId, a.e.id, sticky ? turn + sticky : 0, cooldown ? turn + (sticky || 0) + cooldown : 0);
  }
}

export function loadTimers(chatId) {
  return new Map(db.prepare('SELECT * FROM lore_timers WHERE chat_id = ?').all(chatId).map((t) => [t.entry_id, t]));
}

// ---------------------------------------------------------------------------
// AI compile: a cheap model turns a document into dense, keyword-triggered entries
// ---------------------------------------------------------------------------

function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^(chapter|part|section|book|act|scene)\s+[\w.]+/i.test(t)) return true;
  return /^[A-Z][A-Z0-9 '’:,\-]{3,60}$/.test(t);
}

/** Splits a document into titled sections based on headings. */
export function splitSections(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { title: '', body: [] };
  for (const line of lines) {
    if (isHeading(line)) {
      if (current.body.join('').trim()) sections.push(current);
      current = { title: line.replace(/^#+\s*/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('').trim()) sections.push(current);
  return sections.map((s) => ({ title: s.title, text: s.body.join('\n').trim() }));
}

/** Splits text into pieces no larger than maxTokens, preferring paragraph, then sentence boundaries. */
export function splitBySize(text, maxTokens) {
  const maxChars = Math.max(200, Math.floor(maxTokens * 3.6));
  if (text.length <= maxChars) return [text];
  const out = [];
  let buf = '';
  const push = (p) => {
    if ((buf ? buf.length + 2 : 0) + p.length > maxChars && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  };
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length <= maxChars) { push(para); continue; }
    for (const sentence of para.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [para]) {
      if (sentence.length > maxChars) for (let i = 0; i < sentence.length; i += maxChars) push(sentence.slice(i, i + maxChars));
      else if ((buf + sentence).length > maxChars && buf) { out.push(buf); buf = sentence; }
      else buf += sentence;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function chunkDocument(text, maxTokens) {
  const chunks = [];
  let buf = '';
  for (const s of splitSections(text)) {
    for (const piece of splitBySize(s.text, maxTokens)) {
      const block = s.title ? `## ${s.title}\n${piece}` : piece;
      if (buf && estimateTokens(buf + block) > maxTokens) {
        chunks.push(buf);
        buf = block;
      } else {
        buf = buf ? `${buf}\n\n${block}` : block;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

const COMPILER_PROMPT = `You are a lorebook compiler for an AI writing and roleplay app.
The app does NOT send the source document to the model. It injects individual lorebook entries only when one of
their trigger keywords appears in the recent conversation. Convert the source material into such entries.

Return ONLY a JSON object: {"entries":[{"title":string,"category":string,"keys":string[],"content":string,"priority":number,"constant":boolean}]}

Rules (the user's instructions below override these):
- One entry per distinct subject (character, place, faction, item, event, concept, rule of the world).
- "content": dense, factual, third person, self-contained (name the subject in the first sentence). Usually 50-180 words.
  Keep what matters for writing and roleplay: appearance, personality, relationships, history, abilities, current status, how places look and are laid out.
- For characters, include 1-3 short VERBATIM lines of their dialogue from the source (in quotes) that show how they talk.
- "keys": 2-6 specific triggers: names, nicknames, titles, distinctive terms. Never generic words alone ("the", "city", "war").
- "category": Character, Location, Faction, Item, Event, Concept or Rule.
- "priority": 0-200; core subjects higher (default 100).
- "constant": true ONLY for a couple of core world facts needed in nearly every scene. Almost always false.
- Never invent facts that are not in the source.`;

export async function estimateCompile(documentId, instructions = '') {
  const s = getSettings();
  const doc = db.prepare('SELECT text FROM documents WHERE id = ?').get(documentId);
  if (!doc) throw httpError(404, 'Document not found');
  const chunks = chunkDocument(doc.text, s.compileChunkTokens);
  const docTokens = estimateTokens(doc.text);
  const inputTokens = docTokens + chunks.length * (estimateTokens(COMPILER_PROMPT + instructions) + 30);
  const outputTokens = Math.round(docTokens * 0.5);
  const price = await modelPrice(s.utilityModel);
  return {
    model: s.utilityModel,
    chunks: chunks.length,
    documentTokens: docTokens,
    inputTokens,
    outputTokens,
    estimatedCost: price ? inputTokens * price.prompt + outputTokens * price.completion : null
  };
}

const jobs = new Map();
let jobSeq = 0;
export const getJob = (id) => jobs.get(Number(id)) || null;

/** Compiles a document into a lorebook in the background (3 chunks at a time). Returns a job to poll. */
export function startCompile(documentId, lorebookId, instructions = '') {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) throw httpError(404, 'Document not found');
  if (!db.prepare('SELECT id FROM lorebooks WHERE id = ?').get(lorebookId)) throw httpError(404, 'Lorebook not found');
  const s = getSettings();
  const chunks = chunkDocument(doc.text, s.compileChunkTokens);
  const job = { id: ++jobSeq, status: 'running', done: 0, total: chunks.length, added: 0, errors: [] };
  jobs.set(job.id, job);
  let system = COMPILER_PROMPT;
  if (instructions.trim()) system += `\n\nUSER'S INSTRUCTIONS (follow these first):\n${instructions.trim()}`;
  (async () => {
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          const out = await completeJSON({
            task: 'compile',
            expect: 'entries',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `Source chunk ${i + 1} of ${chunks.length} (from "${doc.name}"):\n\n${chunks[i]}` }
            ],
            maxTokens: Math.min(8000, Math.round(s.compileChunkTokens * 1.2) + 500),
            temperature: 0.2
          });
          job.added += mergeEntries(lorebookId, out.entries || []);
        } catch (e) {
          job.errors.push(`Chunk ${i + 1}: ${e.message}`);
        }
        job.done++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    job.status = job.errors.length && !job.added ? 'error' : 'done';
  })();
  return job;
}

/** Inserts entries, merging into an existing entry with the same title (chunks often split one subject). */
export function mergeEntries(lorebookId, entries) {
  let added = 0;
  tx(() => {
    for (const raw of entries) {
      const e = normalizeEntry(raw);
      if (!e.content.trim()) continue;
      const existing = db.prepare('SELECT * FROM lore_entries WHERE lorebook_id = ? AND lower(title) = lower(?)').get(lorebookId, e.title);
      if (existing) {
        const keys = [...new Set([...parseJSON(existing.keys, []), ...parseJSON(e.keys, [])])];
        const content = existing.content.includes(e.content) ? existing.content : `${existing.content}\n${e.content}`;
        db.prepare('UPDATE lore_entries SET keys = ?, content = ?, tokens = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(keys), content, estimateTokens(content), existing.id);
      } else {
        db.prepare(`INSERT INTO lore_entries (lorebook_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`).run(lorebookId, ...FIELDS.map((f) => e[f]));
        added++;
      }
    }
  });
  return added;
}
