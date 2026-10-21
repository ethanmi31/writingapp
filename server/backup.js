import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, tx, avatarDir } from './db.js';
import { indexDocument } from './documents.js';
import { httpError } from './openrouter.js';

// One-file backup of everything (except the API key and usage log). Restoring always ADDS copies — it never
// overwrites what's already there — so it doubles as "move my library to another computer".

const TABLES = ['lorebooks', 'lore_entries', 'documents', 'characters', 'chats', 'chat_lorebooks', 'chat_documents', 'chat_characters', 'messages', 'lore_timers', 'snapshots'];

export function exportAll() {
  const data = { format: 'inkwell-backup', version: 1, exported_at: new Date().toISOString(), avatars: {} };
  for (const t of TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  for (const c of data.characters) {
    if (!c.avatar) continue;
    try { data.avatars[c.avatar] = fs.readFileSync(path.join(avatarDir, c.avatar)).toString('base64'); } catch {}
  }
  return data;
}

export function importAll(data) {
  if (data?.format !== 'inkwell-backup') throw httpError(400, "That isn't an Inkwell backup file.");
  const maps = Object.fromEntries(['lorebooks', 'lore_entries', 'documents', 'characters', 'chats', 'messages'].map((t) => [t, new Map()]));
  const insert = (table, row, skip = ['id']) => {
    const cols = Object.keys(row).filter((k) => !skip.includes(k));
    const r = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k]));
    return Number(r.lastInsertRowid);
  };
  const remap = (t, v) => (v == null ? v : maps[t].get(v) ?? null);
  const counts = {};
  tx(() => {
    for (const c of data.characters || []) {
      let avatar = '';
      if (c.avatar && data.avatars?.[c.avatar]) {
        avatar = `${crypto.randomUUID()}${path.extname(c.avatar) || '.png'}`;
        fs.writeFileSync(path.join(avatarDir, avatar), Buffer.from(data.avatars[c.avatar], 'base64'));
      }
      maps.characters.set(c.id, insert('characters', { ...c, avatar }));
    }
    for (const b of data.lorebooks || []) maps.lorebooks.set(b.id, insert('lorebooks', { ...b, character_id: remap('characters', b.character_id) }));
    for (const e of data.lore_entries || []) {
      const book = remap('lorebooks', e.lorebook_id);
      if (book) maps.lore_entries.set(e.id, insert('lore_entries', { ...e, lorebook_id: book }));
    }
    for (const d of data.documents || []) {
      const nid = insert('documents', d);
      maps.documents.set(d.id, nid);
      indexDocument(nid, d.text);
    }
    for (const c of data.chats || []) maps.chats.set(c.id, insert('chats', { ...c, persona_id: remap('characters', c.persona_id) }));
    for (const m of data.messages || []) {
      const chat = remap('chats', m.chat_id);
      if (chat) maps.messages.set(m.id, insert('messages', { ...m, chat_id: chat }));
    }
    // summaries refer to message ids
    for (const c of data.chats || []) {
      if (c.summarized_upto) db.prepare('UPDATE chats SET summarized_upto = ? WHERE id = ?').run(remap('messages', c.summarized_upto) || 0, remap('chats', c.id));
    }
    const link = (table, a, ta, b, tb, extra = []) => {
      for (const r of data[table] || []) {
        const x = remap(ta, r[a]);
        const y = remap(tb, r[b]);
        if (x && y) insert(table, { ...r, [a]: x, [b]: y }, ['id', ...extra]);
      }
    };
    link('chat_lorebooks', 'chat_id', 'chats', 'lorebook_id', 'lorebooks');
    link('chat_documents', 'chat_id', 'chats', 'document_id', 'documents');
    link('chat_characters', 'chat_id', 'chats', 'character_id', 'characters');
    link('lore_timers', 'chat_id', 'chats', 'entry_id', 'lore_entries');
    link('snapshots', 'message_id', 'messages', 'chat_id', 'chats');
  });
  for (const t of Object.keys(maps)) counts[t] = maps[t].size;
  return counts;
}
