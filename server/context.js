import { db, estimateTokens, getSettings, parseJSON } from './db.js';
import { activateLore, chatEntries, loadTimers } from './lorebook.js';
import { chatDocumentIds, retrieveForChat } from './documents.js';
import { loadMap, mapText, playerEntity, ancestry } from './tracker.js';
import { httpError } from './openrouter.js';

const join = (parts) => parts.filter((p) => p && String(p).trim()).join('\n\n');

export function getChat(id) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(id));
  if (!chat) throw httpError(404, 'Chat not found');
  return chat;
}

export const chatOptions = (chat) => parseJSON(chat.options, {});

export function chatCharacters(chatId) {
  return db.prepare('SELECT c.* FROM chat_characters cc JOIN characters c ON c.id = cc.character_id WHERE cc.chat_id = ? ORDER BY cc.position, c.id').all(chatId);
}

export function chatPersona(chat) {
  return chat.persona_id ? db.prepare('SELECT * FROM characters WHERE id = ?').get(chat.persona_id) : null;
}

/** Names used by {{user}} and {{char}}. */
export function chatNames(chat) {
  const persona = chatPersona(chat);
  const chars = chatCharacters(chat.id);
  return { user: persona?.name || (chat.mode === 'writing' ? 'the author' : 'User'), char: chars[0]?.name || 'Narrator', persona, chars };
}

/** SillyTavern-style macros in prompts, cards and lore. */
export function macros(text, { user, char }) {
  return String(text ?? '')
    .replace(/\{\{user\}\}|<USER>/gi, user)
    .replace(/\{\{char\}\}|<BOT>/gi, char)
    .replace(/\{\{random::?([^}]*)\}\}/gi, (_, list) => {
      const opts = list.split(/::|,/).map((x) => x.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(Math.random() * opts.length)] : '';
    })
    .replace(/\{\{roll:?\s*(\d*)d(\d+)\}\}/gi, (_, n, d) => String(Array.from({ length: Number(n) || 1 }, () => 1 + Math.floor(Math.random() * Number(d))).reduce((a, b) => a + b, 0)))
    .replace(/\{\{time\}\}/gi, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{\{date\}\}/gi, new Date().toLocaleDateString())
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, ''); // {{// comments}}
}

function cardBlock(c) {
  const examples = c.example_dialogue?.trim()
    ? `How ${c.name} talks (examples, not events that happened):\n${c.example_dialogue.replace(/<START>/gi, '---').trim()}`
    : '';
  return join([`### ${c.name}`, c.description, c.personality && `Personality: ${c.personality}`, examples]);
}

/** The end of the manuscript, cut on a paragraph boundary. */
export function manuscriptTail(text, tokens) {
  const t = String(text || '').trim();
  const maxChars = Math.floor(tokens * 3.6);
  if (t.length <= maxChars) return { text: t, cut: false };
  let tail = t.slice(-maxChars);
  const para = tail.indexOf('\n\n');
  if (para > 0 && para < maxChars * 0.3) tail = tail.slice(para + 2);
  return { text: tail, cut: true };
}

const words = (t) => (String(t || '').match(/\S+/g) || []).length;

/** Names the lorebook should treat as "mentioned" in roleplay: where the player is and who's there. */
function mapScanText(map, playerName) {
  const p = playerEntity(structuredClone(map), playerName);
  if (!p.location) return '';
  const chain = ancestry(map, p.location);
  const present = map.entities.filter((e) => e.location === p.location && e.kind !== 'player');
  return [...chain.map((l) => l.name), ...present.map((e) => e.name)].join('\n');
}

/** A message as it goes to the model. Out-of-character notes are sent as clearly marked user turns. */
function asTurn(m, names) {
  if (m.role === 'system') return { role: 'user', content: `[OOC note: ${m.content}]` };
  return { role: m.role, content: m.content };
}

/**
 * Messages that fell out of the window but aren't in the summary yet — plus the oldest third of the window,
 * so the summary runs in batches every several turns instead of after every reply.
 */
function pendingSummary(visible, window, upto) {
  if (!window.length) return [];
  const dropped = visible.filter((m) => m.id > upto && m.id < window[0].id);
  if (!dropped.length) return [];
  return [...dropped, ...window.slice(0, Math.floor(window.length / 3)).filter((m) => m.id > upto)];
}

/**
 * Builds the full prompt for the next AI turn.
 *  history: the chat's messages up to the point being generated (oldest first)
 *  kind: reply | continue | impersonate
 *  guidance: one-off direction for this reply ("have the guard recognise me")
 */
export async function buildPrompt(chat, { history, kind = 'reply', guidance = '', dryRun = false }) {
  const s = getSettings();
  const opt = chatOptions(chat);
  const rp = chat.mode === 'roleplay';
  const names = chatNames(chat);
  const M = (t) => macros(t, names);
  const visible = history.filter((m) => !m.hidden);
  const turn = visible.length;
  const map = rp ? loadMap(chat) : null;
  const ms = !rp ? manuscriptTail(chat.manuscript, opt.manuscriptTokens ?? s.manuscriptTokens) : null;

  // --- lorebooks
  const recentText = visible.slice(-30).map((m) => m.content);
  if (guidance) recentText.push(guidance);
  // also "mentioned": the cast of this chat, plus where the player is and who's there (roleplay) or the end of the manuscript (writing)
  const extra = [names.chars.map((c) => c.name).join('\n'), rp ? mapScanText(map, names.user) : ms.text.slice(-3000)].join('\n');
  const lore = activateLore({
    entries: chatEntries(chat.id, chat.mode),
    recent: recentText,
    extra,
    turn,
    timers: dryRun ? new Map() : loadTimers(chat.id),
    budget: opt.loreBudget ?? s.loreBudget,
    settings: s
  });

  // --- static blocks
  const systemPrompt = join([
    M(rp ? s.roleplaySystemPrompt : s.writingSystemPrompt),
    M(chat.system_prompt),
    ...names.chars.map((c) => M(c.system_prompt))
  ]);
  const scenario = join([...names.chars.map((c) => M(c.scenario)), M(chat.notes)]);
  const definitions = rp
    ? join([
        names.chars.length ? `CHARACTERS (you play these):\n${names.chars.map((c) => M(cardBlock(c))).join('\n\n')}` : '',
        `${names.user.toUpperCase()} (the player — never write their actions, words or thoughts):\n${M(names.persona?.description || `${names.user} is the player character.`)}`,
        scenario && `SCENARIO:\n${scenario}`
      ])
    : join([
        names.chars.length ? `CHARACTER PROFILES:\n${names.chars.map((c) => M(cardBlock(c))).join('\n\n')}` : '',
        chat.notes?.trim() && `STORY NOTES & OUTLINE (from the author — always follow these):\n${M(chat.notes)}`
      ]);

  // --- dynamic state: map (roleplay) or manuscript (writing)
  const mapBlock = rp && mapText(map, names.user);
  const stateBlock = rp
    ? mapBlock && `MAP & SCENE STATE (authoritative — keep positions, outfits, items and who-can-see-whom consistent with it):\n${mapBlock}`
    : ms.text && `MANUSCRIPT${ms.cut ? ` — the latest part (the whole draft is ${words(chat.manuscript).toLocaleString()} words)` : ` (${words(chat.manuscript).toLocaleString()} words)`}:\n${ms.text}`;

  // --- documents: only what the lorebooks don't already cover
  const latest = guidance || [...visible].reverse().find((m) => m.role === 'user')?.content || visible[visible.length - 1]?.content || '';
  const docs = await retrieveForChat({
    chat,
    docIds: chatDocumentIds(chat.id),
    mode: opt.docMode ?? s.docMode,
    latest,
    recent: visible.slice(-6),
    loreResult: lore,
    // what the AI already has as facts (chat history doesn't count: it often just repeats the name being asked about)
    knownContext: join([definitions, stateBlock, chat.summary]),
    budget: opt.docBudget ?? s.docBudget
  });

  const loreBefore = lore.before && `LORE:\n${M(lore.before)}`;
  const loreAfter = lore.after && `MORE LORE:\n${M(lore.after)}`;
  const head = [
    { role: 'system', content: systemPrompt },
    { role: 'system', content: join([loreBefore, definitions, loreAfter]) },
    { role: 'system', content: join([stateBlock, docs.text && `REFERENCE EXCERPTS (from the source documents — use them for accurate facts; don't copy them wholesale):\n${docs.text}`]) }
  ].filter((m) => m.content.trim());

  // --- final instructions, after the history
  const tail = [];
  const post = join(names.chars.map((c) => M(c.post_history)));
  if (kind === 'impersonate') {
    tail.push(
      rp
        ? `[Write ${names.user}'s next message, as ${names.user} would write it, in their voice: their action and/or dialogue only, 1-2 short paragraphs, matching the style of their earlier messages. Don't write anyone else's reactions.]`
        : '[Write the next message the author would send to you: what they would ask for or write next. Write it as them, in first person.]'
    );
  } else if (kind === 'continue') {
    tail.push('[Continue your last reply exactly where it stopped, mid-sentence if needed. Output only the continuation — do not repeat or summarize what is already written.]');
  } else {
    if (post) tail.push(post);
    if (rp) tail.push(`[Write the next reply. Stay consistent with the map. Do not write ${names.user}'s actions, dialogue or thoughts.]`);
  }
  if (guidance.trim()) tail.push(`[Direction for this reply only: ${M(guidance.trim())}]`);
  const tailMsgs = tail.length ? [{ role: 'system', content: tail.join('\n') }] : [];

  // --- history: as many recent messages as fit; older ones live on in the rolling summary
  const maxContext = opt.maxContextTokens ?? s.maxContextTokens;
  const replyTokens = opt.maxTokens ?? (rp ? s.roleplayMaxTokens : s.writingMaxTokens);
  const fixed = estimateTokens([...head, ...tailMsgs].map((m) => m.content).join('\n')) + estimateTokens(chat.summary) + estimateTokens(chat.author_note) + estimateTokens(lore.an) + 60;
  const historyBudget = Math.max(800, maxContext - fixed - replyTokens);
  const window = [];
  let used = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    const t = estimateTokens(visible[i].content) + 4;
    if (used + t > historyBudget && window.length >= 2) break;
    window.unshift(visible[i]);
    used += t;
  }
  const dropped = visible.length - window.length;
  const summaryBlock = dropped > 0 && chat.summary?.trim() ? { role: 'system', content: `EARLIER IN THIS ${rp ? 'STORY' : 'CONVERSATION'} (summary of messages no longer shown):\n${chat.summary}` } : null;

  const turns = window.map((m) => asTurn(m, names));
  // author's note and depth-positioned lore go N messages from the end
  const inserts = [];
  const an = join([M(chat.author_note), lore.an && M(lore.an)]);
  if (an) inserts.push({ depth: Math.max(0, Number(chat.author_note_depth ?? 3)), content: `[Author's note: ${an}]` });
  for (const d of lore.depth) if (d.text) inserts.push({ depth: d.depth, content: M(d.text) });
  for (const ins of inserts.sort((a, b) => a.depth - b.depth)) {
    turns.splice(Math.max(0, turns.length - ins.depth), 0, { role: 'system', content: ins.content });
  }

  const messages = [...head, ...(summaryBlock ? [summaryBlock] : []), ...turns, ...tailMsgs];
  // providers that need a user turn before the first assistant turn (greetings) get a neutral opener
  const firstChat = messages.findIndex((m) => m.role !== 'system');
  if (firstChat >= 0 && messages[firstChat].role === 'assistant') messages.splice(firstChat, 0, { role: 'user', content: rp ? '[The story begins.]' : '[Start]' });
  if (firstChat < 0) messages.push({ role: 'user', content: rp ? '[Begin the story.]' : '[Begin.]' });
  // merge consecutive turns of the same role (some providers reject them)
  const merged = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && m.role !== 'system') prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }

  const tokens = {
    system: estimateTokens(systemPrompt),
    definitions: estimateTokens(definitions),
    lore: lore.tokens,
    state: estimateTokens(stateBlock || ''),
    documents: docs.tokens || 0,
    summary: summaryBlock ? estimateTokens(chat.summary) : 0,
    history: used,
    total: estimateTokens(merged.map((m) => m.content).join('\n'))
  };
  return {
    messages: merged,
    lore,
    docs,
    replyTokens,
    meta: {
      lore: lore.trace,
      docs: { mode: docs.mode, reason: docs.reason, queries: docs.queries, chunks: docs.chunks, pinned: docs.pinned },
      tokens,
      historyMessages: window.length,
      dropped
    },
    unsummarized: pendingSummary(visible, window, chat.summarized_upto || 0),
    turn,
    names
  };
}
