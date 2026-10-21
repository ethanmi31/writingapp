import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-test-'));
const { db } = await import('../server/db.js');
const { keyMatcher, activateLore, insertEntries, chatEntries, parseSillyTavernLorebook, exportSillyTavern } = await import('../server/lorebook.js');
const { addDocument, searchChunks, extractTerms } = await import('../server/documents.js');
const { applyOps, emptyMap, mapText, playerEntity } = await import('../server/tracker.js');
const { macros } = await import('../server/context.js');

const entry = (o) => ({ id: o.id, lorebook_id: 1, title: o.title || `e${o.id}`, keys: JSON.stringify(o.keys || []), secondary_keys: JSON.stringify(o.secondary || []), logic: o.logic || 'and_any',
  content: o.content || `content ${o.id}`, enabled: 1, constant: o.constant ? 1 : 0, priority: o.priority ?? 100, position: o.position || 'before', depth: 4, probability: o.probability ?? 100,
  case_sensitive: null, whole_words: null, scan_depth: o.scan_depth ?? null, sticky: o.sticky || 0, cooldown: o.cooldown || 0, delay: o.delay || 0, group_name: o.group || '', group_weight: o.weight || 100,
  group_override: o.override ? 1 : 0, exclude_recursion: o.exclude_recursion ? 1 : 0, prevent_recursion: o.prevent_recursion ? 1 : 0, delay_until_recursion: o.delay_until_recursion ? 1 : 0,
  ignore_budget: 0, modes: 'both', tokens: 10, book_name: 'b', book_scan_depth: null, book_recursive: 1, book_budget: null });
const settings = { loreBudget: 1000, scanDepth: 4, recursionSteps: 3, matchInflections: true, wholeWords: true, caseSensitive: false };
const ids = (r) => r.chosen.map((a) => a.e.id).sort((a, b) => a - b);

test('keys: whole words, inflections, regex', () => {
  assert.ok(keyMatcher('dragon').test('two dragons flew'));
  assert.ok(keyMatcher('Kael').test("Kael's sword"));
  assert.ok(!keyMatcher('Kael').test('Kaelith arrived'));
  assert.ok(keyMatcher('/mira(bel)?/i').test('MIRABEL'));
  assert.ok(keyMatcher('Éowyn').test('and Éowyn rode'));
  assert.ok(!keyMatcher('cat', { inflections: false }).test('cats'));
});

test('activation: secondary logic, recursion, groups, sticky/cooldown, delay', () => {
  const entries = [
    entry({ id: 1, keys: ['Mira'] }),
    entry({ id: 2, keys: ['Mira'], secondary: ['fire'], logic: 'and_any' }),
    entry({ id: 3, keys: ['Mira'], secondary: ['fire'], logic: 'not_any' }),
    entry({ id: 4, keys: ['Ashford'], content: 'Ashford burned. Ask the Warden.' }),
    entry({ id: 5, keys: ['Warden'] }),
    entry({ id: 6, keys: ['Warden'], exclude_recursion: true }),
    entry({ id: 7, constant: true }),
    entry({ id: 8, keys: ['Mira'], group: 'g', override: true, priority: 5 }),
    entry({ id: 9, keys: ['Mira'], group: 'g', override: true, priority: 50 }),
    entry({ id: 10, keys: ['Mira'], delay: 10 }),
    entry({ id: 11, keys: ['Ashford'], delay_until_recursion: true }),
    entry({ id: 12, keys: ['Warden'], delay_until_recursion: true })
  ];
  const r = activateLore({ entries, recent: ['Mira looks at the fire. She thinks of Ashford.'], turn: 2, settings, random: () => 0 });
  assert.deepEqual(ids(r), [1, 2, 4, 5, 7, 9, 11, 12]); // 11: "Ashford" appears in entry 4's text
  // sticky keeps an entry for N turns even when its key is gone; cooldown blocks it afterwards
  const timers = new Map([[5, { sticky_until: 5, cooldown_until: 0 }], [1, { sticky_until: 0, cooldown_until: 9 }]]);
  const r2 = activateLore({ entries, recent: ['nothing relevant, but Mira'], turn: 4, timers, settings, random: () => 0 });
  assert.ok(ids(r2).includes(5));
  assert.ok(!ids(r2).includes(1));
});

test('activation respects the token budget and ranks constant first', () => {
  const entries = [entry({ id: 1, keys: ['a'], priority: 1 }), entry({ id: 2, keys: ['a'], priority: 200 }), entry({ id: 3, constant: true, priority: 0 })];
  const r = activateLore({ entries, recent: ['a'], settings: { ...settings, loreBudget: 20 }, random: () => 0 });
  assert.deepEqual(ids(r), [2, 3]);
  assert.ok(r.trace.some((t) => t.id === 1 && /budget/.test(t.skipped)));
});

test('SillyTavern round trip', () => {
  const st = { entries: { 0: { key: ['Mira'], keysecondary: ['fire'], selectiveLogic: 2, comment: 'Mira', content: 'Mira is a smith.', order: 150, position: 4, depth: 2, sticky: 3, group: 'people', probability: 80, useProbability: true } } };
  const parsed = parseSillyTavernLorebook(st);
  assert.equal(parsed[0].logic, 'not_any');
  assert.equal(parsed[0].position, 'depth');
  const book = Number(db.prepare("INSERT INTO lorebooks (name) VALUES ('t')").run().lastInsertRowid);
  insertEntries(book, parsed);
  const out = exportSillyTavern(book).entries[0];
  assert.equal(out.selectiveLogic, 2);
  assert.equal(out.position, 4);
  assert.equal(out.sticky, 3);
  assert.equal(out.probability, 80);
  const chat = Number(db.prepare("INSERT INTO chats (title, mode) VALUES ('c', 'writing')").run().lastInsertRowid);
  db.prepare('INSERT INTO chat_lorebooks VALUES (?, ?)').run(chat, book);
  assert.equal(chatEntries(chat, 'writing').length, 1);
});

test('documents: full-text search finds the right passage', () => {
  const text = '# Chapter One\nMira grew up in Ashford, a mining town.\n\n# Chapter Two\nThe ship Grey Heron carried them across the Sundering Sea to Port Vell.';
  const d = addDocument('book.md', text);
  const hits = searchChunks([d.id], ['Grey Heron'], 3);
  assert.equal(hits[0].heading, 'Chapter Two');
  const t = extractTerms('What was the name of the ship that took Mira to "Port Vell"?');
  assert.ok(t.phrases.includes('Port Vell'));
  assert.ok(t.names.includes('Mira'));
});

test('map ops: nesting, movement, layout without overlap', () => {
  const map = emptyMap();
  applyOps(map, [
    { op: 'location', name: 'Harbor District', type: 'area' },
    { op: 'location', name: 'The Rusty Anchor', type: 'building', parent: 'Harbor District', x: 30, y: 30, w: 30, h: 30 },
    { op: 'location', name: 'Bar', type: 'room', parent: 'The Rusty Anchor', x: 50, y: 50, w: 50, h: 50 },
    { op: 'location', name: 'Kitchen', type: 'room', parent: 'Rusty Anchor', x: 50, y: 50, w: 50, h: 50 },
    { op: 'connect', a: 'Bar', b: 'Kitchen', kind: 'door' },
    { op: 'entity', name: 'Mira', location: 'Kitchen', doing: 'cooking' },
    { op: 'entity', name: 'Assassin', location: 'Bar', hidden: true, known: false, alias: 'hooded figure' },
    { op: 'player', location: 'Bar', outfit: 'travel cloak', inventory: ['dagger'] }
  ], 'Alex');
  const bar = map.locations.find((l) => l.name === 'Bar');
  const kitchen = map.locations.find((l) => l.name === 'Kitchen');
  assert.equal(kitchen.parent, map.locations.find((l) => l.name === 'The Rusty Anchor').id);
  assert.ok(Math.abs(bar.x - kitchen.x) * 2 >= bar.w + kitchen.w || Math.abs(bar.y - kitchen.y) * 2 >= bar.h + kitchen.h, 'siblings overlap');
  assert.equal(playerEntity(map, 'Alex').location, bar.id);
  const full = mapText(map, 'Alex');
  const player = mapText(map, 'Alex', 'player');
  assert.ok(full.includes('Assassin') && full.includes('HIDDEN'));
  assert.ok(!player.includes('Assassin') && !player.includes('hooded figure'));
  applyOps(map, [{ op: 'location', name: 'Bar', parent: 'Bar' }], 'Alex'); // can't be its own parent
  assert.notEqual(bar.parent, bar.id);
});

test('macros', () => {
  assert.equal(macros('{{char}} greets {{user}}. <USER>!', { user: 'Alex', char: 'Mira' }), 'Mira greets Alex. Alex!');
  assert.match(macros('{{roll:2d6}}', { user: 'a', char: 'b' }), /^\d+$/);
});
