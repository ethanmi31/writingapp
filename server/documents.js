import { db, estimateTokens, getSettings, tx, parseJSON } from './db.js';
import { splitSections, splitBySize } from './lorebook.js';
import { completeJSON, httpError } from './openrouter.js';

// Documents are split into small chunks in a full-text index (SQLite FTS5, BM25 ranking, stemming), so even
// book-length files cost nothing until a passage is actually needed — and then only that passage is sent.

const CHUNK_TOKENS = 320;

export function addDocument(name, text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) throw httpError(400, 'That document has no text in it.');
  const id = Number(
    db.prepare('INSERT INTO documents (name, text, chars, tokens) VALUES (?, ?, ?, ?)').run(name, clean, clean.length, estimateTokens(clean)).lastInsertRowid
  );
  indexDocument(id, clean);
  return db.prepare('SELECT id, name, chars, tokens, chunks, created_at FROM documents WHERE id = ?').get(id);
}

export function indexDocument(id, text) {
  const ins = db.prepare('INSERT INTO doc_chunks (document_id, idx, heading, body) VALUES (?, ?, ?, ?)');
  let n = 0;
  tx(() => {
    db.prepare('DELETE FROM doc_chunks WHERE document_id = ?').run(id);
    for (const s of splitSections(text)) {
      for (const piece of splitBySize(s.text, CHUNK_TOKENS)) ins.run(id, n++, s.title, piece);
    }
    db.prepare('UPDATE documents SET chunks = ? WHERE id = ?').run(n, id);
  });
  return n;
}

export function deleteDocument(id) {
  tx(() => {
    db.prepare('DELETE FROM doc_chunks WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  });
}

export const chatDocumentIds = (chatId) => db.prepare('SELECT document_id FROM chat_documents WHERE chat_id = ?').all(chatId).map((r) => r.document_id);

const STOP = new Set(
  `the a an and or but of to in on at for with from by is are was were be been being this that these those it its as into over under about after before
  their there they them his her he she we you i me my mine your yours our us him hers who whom whose what which when where why how not no yes do does did
  done have has had having can could would should will shall may might must just only very really also then than so such too more most some any all each
  every other another again still even ever never always here now well back out up down off like get got go goes going went come came make made want
  know think say said tell told see saw look looked let lets please write writing scene story chapter part section book continue next last first one two
  okay ok yeah hey thing things something someone anything nothing way time little much many own same new old good bad describe give show help try
  add use keep start stop find take put turn ask need feel seem leave call maybe perhaps actually suddenly meanwhile later today tonight tomorrow
  yesterday while once sure thanks thank great nice cool fine because since though although however oh ah um hmm wait listen draft rewrite expand
  brainstorm idea ideas character characters dialogue prose paragraph paragraphs sentence words word message beat`.split(/\s+/)
);

/** Search terms from free text: quoted phrases and proper nouns first, then other meaningful words. */
export function extractTerms(text, { content = true } = {}) {
  const t = String(text || '');
  const phrases = [...t.matchAll(/["“]([^"”\n]{3,60})["”]/g)].map((m) => m[1].trim()).filter((p) => p.split(/\s+/).length <= 6);
  const names = [];
  for (const m of t.matchAll(/(?<![\p{L}'’])(\p{Lu}[\p{L}'’-]+(?:\s+(?:of|the|de|von|van)?\s*\p{Lu}[\p{L}'’-]+)*)/gu)) {
    const n = m[1].replace(/['’]s$/, '');
    if (n.length < 3 || STOP.has(n.toLowerCase())) continue;
    names.push(n);
  }
  const words = content
    ? [...t.toLowerCase().matchAll(/\p{L}[\p{L}'’-]{3,}/gu)].map((m) => m[0].replace(/['’]s$/, '')).filter((w) => !STOP.has(w))
    : [];
  const uniq = (a) => [...new Map(a.map((x) => [x.toLowerCase(), x])).values()];
  return { phrases: uniq(phrases), names: uniq(names), words: uniq(words) };
}

const ftsPhrase = (term) => `"${String(term).replace(/"/g, '').trim()}"`;

/** BM25 search over the given documents. Headings count double. */
export function searchChunks(docIds, terms, limit = 8) {
  const clean = terms.map((x) => String(x).replace(/["*^:(){}]/g, ' ').trim()).filter((x) => x.length >= 2);
  if (!docIds.length || !clean.length) return [];
  const query = clean.map(ftsPhrase).join(' OR ');
  try {
    return db
      .prepare(
        `SELECT c.document_id, c.idx, c.heading, c.body, d.name AS doc, bm25(doc_chunks, 0, 0, 2.0, 1.0) AS score
         FROM doc_chunks c JOIN documents d ON d.id = c.document_id
         WHERE doc_chunks MATCH ? AND c.document_id IN (${docIds.map(() => '?').join(',')})
         ORDER BY score LIMIT ?`
      )
      .all(query, ...docIds, limit);
  } catch (e) {
    console.error('document search failed:', e.message);
    return [];
  }
}

export function getChunk(documentId, idx) {
  return db.prepare('SELECT c.document_id, c.idx, c.heading, c.body, d.name AS doc FROM doc_chunks c JOIN documents d ON d.id = c.document_id WHERE c.document_id = ? AND c.idx = ?').get(documentId, idx);
}

/** Manual search from the Documents panel: snippets with the hits marked. */
export function searchForUser(docIds, q, limit = 20) {
  const { phrases, names, words } = extractTerms(q);
  const terms = [...phrases, ...names, ...words];
  if (!terms.length) return [];
  return searchChunks(docIds, terms, limit).map((r) => ({ ...r, tokens: estimateTokens(r.body) }));
}

/**
 * Is a term already covered by what's in the prompt? A name is covered if an activated lore entry is about it
 * (title/keys) or the loaded context mentions it repeatedly; a plain word if the context mentions it at all.
 */
function coverage(context, activatedKeys) {
  const lower = context.toLowerCase();
  const count = (term) => {
    const re = new RegExp(`(?<![\\p{L}])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gu');
    return (lower.match(re) || []).length;
  };
  return {
    name: (n) => activatedKeys.has(n.toLowerCase()) || count(n) >= 2,
    word: (w) => count(w) >= 1
  };
}

/**
 * Finds what the lorebooks DON'T cover and looks only that up in the chat's documents.
 *  docMode: off | auto (free: uncovered names/terms → BM25) | ai (the utility model decides what's missing) | always
 */
export async function retrieveForChat({ chat, docIds, mode, latest, recent, loreResult, knownContext = '', budget }) {
  const pinned = parseJSON(chat.pinned, []).map((p) => getChunk(p.document_id, p.idx)).filter(Boolean);
  const out = { chunks: [], queries: [], reason: '', mode, pinned: pinned.map(label) };
  if (!docIds.length || mode === 'off') return finish(out, pinned, [], budget);

  const activatedKeys = new Set();
  for (const a of loreResult?.chosen || []) {
    activatedKeys.add(a.e.title.toLowerCase());
    for (const k of parseJSON(a.e.keys, [])) activatedKeys.add(String(k).toLowerCase());
  }
  const context = `${loreResult?.text || ''}\n${knownContext}`;
  const cov = coverage(context, activatedKeys);
  let hits = [];

  if (mode === 'always') {
    const { phrases, names, words } = extractTerms(latest);
    out.queries = [...phrases, ...names, ...words.slice(0, 8)];
    hits = searchChunks(docIds, out.queries, 6);
    out.reason = 'Searched on every message';
  } else if (mode === 'ai') {
    const plan = await planLookup({ latest, recent, loreResult, docIds }).catch((e) => ({ error: e.message }));
    if (plan.error) {
      out.reason = `Lookup planner failed (${plan.error}); used the free check instead`;
      hits = autoLookup(latest, cov, out, docIds);
    } else if (plan.lookup && plan.queries.length) {
      out.queries = plan.queries;
      out.reason = plan.reason || 'The lorebooks were missing details';
      const seen = new Set();
      for (const q of plan.queries) {
        const { phrases, names, words } = extractTerms(q);
        for (const r of searchChunks(docIds, [...phrases, ...names, ...words], 3)) {
          const key = `${r.document_id}:${r.idx}`;
          if (!seen.has(key)) { seen.add(key); hits.push(r); }
        }
      }
    } else {
      out.reason = plan.reason || 'The lorebooks already cover this';
    }
  } else {
    hits = autoLookup(latest, cov, out, docIds);
  }
  return finish(out, pinned, hits, budget);
}

function autoLookup(latest, cov, out, docIds) {
  const { phrases, names, words } = extractTerms(latest);
  const gapNames = [...phrases, ...names].filter((n) => !cov.name(n));
  // plain words only count when the message is asking about something ("what was…", "remember…", "?")
  const asking = /\?|\b(what|who|where|when|why|how|which|remember|recall|describe|according|canon|accurate)\b/i.test(latest);
  const gapWords = asking ? words.filter((w) => !cov.word(w)).slice(0, 6) : [];
  if (!gapNames.length && !gapWords.length) {
    out.reason = 'Everything mentioned is covered by the lorebooks';
    return [];
  }
  out.queries = [...gapNames, ...gapWords];
  out.reason = `Not in the lorebooks: ${out.queries.slice(0, 6).join(', ')}`;
  let hits = searchChunks(docIds, out.queries, 8);
  // with names missing, a passage must mention at least one of them
  if (gapNames.length) hits = hits.filter((h) => gapNames.some((n) => `${h.heading}\n${h.body}`.toLowerCase().includes(n.toLowerCase())));
  return hits.slice(0, 5);
}

async function planLookup({ latest, recent, loreResult, docIds }) {
  const docs = db.prepare(`SELECT name FROM documents WHERE id IN (${docIds.map(() => '?').join(',')})`).all(...docIds).map((d) => d.name);
  const loaded = (loreResult?.chosen || []).map((a) => `- ${a.e.title}: ${a.e.content.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
  const out = await completeJSON({
    task: 'doc-lookup',
    maxTokens: 300,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You decide whether a writing/roleplay AI must look something up in the reference documents before answering.
The lorebook entries already loaded into its context are listed below. Only ask for a lookup when the latest message needs specific facts — names, events, places, descriptions, relationships, timelines, quotes — that are NOT covered by the loaded lore or the recent conversation. Generic creative requests need no lookup.
Return ONLY JSON: {"lookup": boolean, "queries": [short keyword queries, max 4], "reason": "one short sentence"}`
      },
      {
        role: 'user',
        content: `REFERENCE DOCUMENTS: ${docs.join(', ')}

LOADED LORE:
${loaded || '(none)'}

RECENT CONVERSATION:
${recent.slice(-4).map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') || '(none)'}

LATEST MESSAGE:
${latest.slice(0, 2000)}`
      }
    ]
  });
  return {
    lookup: !!out.lookup,
    queries: (Array.isArray(out.queries) ? out.queries : []).map(String).filter(Boolean).slice(0, 4),
    reason: String(out.reason || '')
  };
}

const label = (c) => ({ document_id: c.document_id, idx: c.idx, doc: c.doc, heading: c.heading, tokens: estimateTokens(c.body), preview: c.body.slice(0, 160) });

function finish(out, pinned, hits, budget = getSettings().docBudget) {
  const chosen = [];
  let tokens = 0;
  const seen = new Set();
  for (const c of [...pinned, ...hits]) {
    const key = `${c.document_id}:${c.idx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = estimateTokens(c.body);
    const isPinned = pinned.includes(c);
    if (!isPinned && tokens + t > budget) continue;
    chosen.push(c);
    tokens += t;
  }
  // keep document order, so neighbouring passages read naturally
  chosen.sort((a, b) => a.document_id - b.document_id || a.idx - b.idx);
  out.chunks = chosen.map(label);
  out.tokens = tokens;
  out.text = chosen.map((c) => `[From "${c.doc}"${c.heading ? ` — ${c.heading}` : ''}]\n${c.body}`).join('\n\n');
  return out;
}
