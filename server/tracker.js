import { db, getSettings, parseJSON } from './db.js';
import { completeJSON } from './openrouter.js';

// Roleplay world tracking. After every narrator reply two cheap calls run, in order:
//  1. the MAP KEEPER updates a structured map (locations nested inside each other, connections, and where every
//     person and notable object is, including the player's outfit, inventory and condition);
//  2. the SCENE SIMPLIFIER turns the new state plus the latest prose into a plain-words "what's going on" card.
// The narrator gets the full map in every prompt, and the map keeper gets the full map on every update.

export const LOCATION_TYPES = ['region', 'area', 'building', 'floor', 'room', 'outdoor', 'landmark', 'vehicle'];
const ENTITY_KINDS = ['player', 'npc', 'creature', 'object'];

export function emptyMap() {
  return { locations: [], connections: [], entities: [], time: '', weather: '', seq: 0 };
}

export function loadMap(chat) {
  const m = { ...emptyMap(), ...parseJSON(chat.map, {}) };
  for (const k of ['locations', 'connections', 'entities']) if (!Array.isArray(m[k])) m[k] = [];
  return m;
}

const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const str = (v, max = 400) => (v == null ? '' : String(v).trim().slice(0, max));
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function findLocation(map, name) {
  const n = norm(name);
  if (!n) return null;
  return map.locations.find((l) => norm(l.name) === n) || map.locations.find((l) => l.id === name) || null;
}

export function playerEntity(map, playerName = 'You') {
  let p = map.entities.find((e) => e.kind === 'player');
  if (!p) {
    p = { id: 'player', kind: 'player', name: playerName, location: null, known: true, hidden: false, outfit: '', inventory: [], condition: '', doing: '' };
    map.entities.unshift(p);
  }
  if (playerName && p.name !== playerName) p.name = playerName;
  return p;
}

function findEntity(map, name, playerName) {
  const n = norm(name);
  if (!n) return null;
  if (['user', '{{user}}', 'player', 'you', norm(playerName)].includes(n)) return playerEntity(map, playerName);
  return (
    map.entities.find((e) => norm(e.name) === n) ||
    map.entities.find((e) => e.alias && norm(e.alias) === n) ||
    map.entities.find((e) => e.id === name) ||
    null
  );
}

/** Location ids from the root down to this one. */
export function ancestry(map, locId) {
  const chain = [];
  const seen = new Set();
  let cur = map.locations.find((l) => l.id === locId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = map.locations.find((l) => l.id === cur.parent);
  }
  return chain;
}

const isDescendant = (map, id, ancestorId) => ancestry(map, id).some((l) => l.id === ancestorId);

/** Applies the map keeper's operations. Names are matched loosely; anything unusable is skipped. */
export function applyOps(map, ops, playerName) {
  const log = [];
  const nextId = (p) => `${p}${++map.seq}`;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    try {
      switch (op.op) {
        case 'location': {
          let loc = findLocation(map, op.name) || (op.rename && findLocation(map, op.rename));
          const isNew = !loc;
          if (isNew) {
            if (!str(op.name)) break;
            loc = { id: nextId('l'), name: str(op.name, 80), type: 'room', parent: null, x: null, y: null, w: null, h: null, desc: '' };
            map.locations.push(loc);
          }
          if (op.rename && str(op.rename) && findLocation(map, op.name) === loc) loc.name = str(op.rename, 80);
          if (LOCATION_TYPES.includes(op.type)) loc.type = op.type;
          if ('parent' in op) {
            const parent = op.parent ? findLocation(map, op.parent) : null;
            // never make a place its own ancestor
            if (!parent || (parent.id !== loc.id && !isDescendant(map, parent.id, loc.id))) loc.parent = parent?.id ?? null;
          }
          for (const k of ['x', 'y', 'w', 'h']) if (num(op[k]) != null) loc[k] = num(op[k]);
          if (op.desc != null) loc.desc = str(op.desc, 500);
          log.push(`${isNew ? 'added' : 'updated'} ${loc.name}`);
          break;
        }
        case 'remove_location': {
          const loc = findLocation(map, op.name);
          if (!loc) break;
          for (const child of map.locations.filter((l) => l.parent === loc.id)) child.parent = loc.parent;
          for (const e of map.entities.filter((e) => e.location === loc.id)) e.location = loc.parent;
          map.locations = map.locations.filter((l) => l !== loc);
          map.connections = map.connections.filter((c) => c.a !== loc.id && c.b !== loc.id);
          log.push(`removed ${loc.name}`);
          break;
        }
        case 'connect': {
          const a = findLocation(map, op.a);
          const b = findLocation(map, op.b);
          if (!a || !b || a === b) break;
          const existing = map.connections.find((c) => (c.a === a.id && c.b === b.id) || (c.a === b.id && c.b === a.id));
          if (existing) existing.kind = str(op.kind, 40) || existing.kind;
          else map.connections.push({ a: a.id, b: b.id, kind: str(op.kind, 40) || 'path' });
          break;
        }
        case 'disconnect': {
          const a = findLocation(map, op.a);
          const b = findLocation(map, op.b);
          if (a && b) map.connections = map.connections.filter((c) => !((c.a === a.id && c.b === b.id) || (c.a === b.id && c.b === a.id)));
          break;
        }
        case 'player':
          op.name = playerName;
          op.kind = 'player';
        // falls through
        case 'entity': {
          let ent = findEntity(map, op.name, playerName) || (op.alias && findEntity(map, op.alias, playerName));
          const isNew = !ent;
          if (isNew) {
            if (!str(op.name)) break;
            ent = { id: nextId('e'), kind: 'npc', name: str(op.name, 80), location: null, known: true, hidden: false, alias: '', doing: '', outfit: '', attitude: '', notes: '', knows: [] };
            map.entities.push(ent);
          }
          if (op.rename && str(op.rename) && ent.kind !== 'player') ent.name = str(op.rename, 80);
          if (ENTITY_KINDS.includes(op.kind) && (ent.kind !== 'player' || op.kind === 'player')) ent.kind = op.kind;
          if ('location' in op) {
            const loc = op.location ? findLocation(map, op.location) : null;
            if (loc || !op.location) ent.location = loc?.id ?? null;
            if (loc && num(op.x) == null) { ent.x = null; ent.y = null; } // moved: let the layout place it
          }
          for (const k of ['x', 'y']) if (num(op[k]) != null) ent[k] = num(op[k]);
          for (const k of ['alias', 'doing', 'outfit', 'attitude', 'notes', 'condition']) if (op[k] != null) ent[k] = str(op[k]);
          if (op.known != null) ent.known = !!op.known;
          if (op.hidden != null) ent.hidden = !!op.hidden;
          if (Array.isArray(op.inventory)) ent.inventory = op.inventory.map((i) => str(i, 80)).filter(Boolean).slice(0, 30);
          // what this character knows about the player: "knows" replaces the list, "learned" adds to it
          const facts = (v) => (Array.isArray(v) ? v : []).map((f) => str(f, 140)).filter(Boolean);
          if (ent.kind !== 'player') {
            if (Array.isArray(op.knows)) ent.knows = facts(op.knows);
            if (Array.isArray(op.learned)) ent.knows = [...new Set([...(ent.knows || []), ...facts(op.learned)])];
            if (ent.knows?.length > 25) ent.knows = ent.knows.slice(-25);
          }
          log.push(`${isNew ? 'added' : 'updated'} ${ent.name}`);
          break;
        }
        case 'remove_entity': {
          const ent = findEntity(map, op.name, playerName);
          if (ent && ent.kind !== 'player') {
            map.entities = map.entities.filter((e) => e !== ent);
            log.push(`removed ${ent.name}`);
          }
          break;
        }
        case 'world':
          if (op.time != null) map.time = str(op.time, 80);
          if (op.weather != null) map.weather = str(op.weather, 80);
          break;
      }
    } catch (e) {
      console.error('map op failed:', op, e.message);
    }
  }
  layout(map);
  return log;
}

/**
 * Keeps every place inside its parent (0-100 coordinates, centre + size) without overlapping its siblings.
 * Places the model gave no position get the free spot nearest to the middle.
 */
export function layout(map) {
  const groups = new Map();
  for (const l of map.locations) {
    const k = l.parent || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  for (const siblings of groups.values()) {
    const n = siblings.length;
    const defaultSize = Math.max(14, Math.min(40, 70 / Math.ceil(Math.sqrt(n))));
    const placed = [];
    let crowded = false;
    for (const l of siblings) {
      l.w = Math.max(8, Math.min(90, l.w ?? defaultSize));
      l.h = Math.max(8, Math.min(90, l.h ?? defaultSize * 0.8));
      const want = { x: l.x ?? 50, y: l.y ?? 50 };
      let spot = null;
      for (let shrink = 0; shrink < 6 && !spot; shrink++) {
        if (shrink) { l.w = Math.max(8, l.w * 0.8); l.h = Math.max(8, l.h * 0.8); }
        spot = freeSpot(want, l.w, l.h, placed, l.x == null);
      }
      if (spot) { l.x = spot.x; l.y = spot.y; } else { crowded = true; break; }
      placed.push(l);
    }
    // no room left: lay the whole group out as a grid, keeping its rough top-to-bottom, left-to-right order
    if (crowded) gridLayout(siblings);
    for (const l of siblings) for (const k of ['x', 'y', 'w', 'h']) l[k] = Math.round(l[k] * 10) / 10;
  }
  for (const e of map.entities) {
    if (e.x != null) e.x = Math.max(4, Math.min(96, e.x));
    if (e.y != null) e.y = Math.max(4, Math.min(96, e.y));
  }
}

function gridLayout(siblings) {
  const cols = Math.ceil(Math.sqrt(siblings.length));
  const rows = Math.ceil(siblings.length / cols);
  const cw = 98 / cols;
  const ch = 98 / rows;
  const ordered = [...siblings].sort((a, b) => Math.round((a.y ?? 50) / 20) - Math.round((b.y ?? 50) / 20) || (a.x ?? 50) - (b.x ?? 50));
  ordered.forEach((l, i) => {
    l.w = cw - 3;
    l.h = ch - 3;
    l.x = 1 + cw * (i % cols) + cw / 2;
    l.y = 1 + ch * Math.floor(i / cols) + ch / 2;
  });
}

const clampCentre = (v, size) => Math.max(size / 2 + 1, Math.min(99 - size / 2, v));
const overlaps = (a, b, gap = 1.5) => Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2;

function freeSpot(want, w, h, placed, unplaced) {
  const fits = (x, y) => {
    const r = { x: clampCentre(x, w), y: clampCentre(y, h), w, h };
    return placed.every((p) => !overlaps(r, p)) ? r : null;
  };
  const direct = fits(want.x, want.y);
  if (direct && !unplaced) return direct;
  // search outward from the wanted spot on a grid
  const step = 4;
  let best = direct;
  let bestDist = direct ? 0 : Infinity;
  for (let gx = w / 2 + 1; gx <= 99 - w / 2; gx += step) {
    for (let gy = h / 2 + 1; gy <= 99 - h / 2; gy += step) {
      const d = (gx - want.x) ** 2 + (gy - want.y) ** 2;
      if (d >= bestDist) continue;
      const r = fits(gx, gy);
      if (r) { best = r; bestDist = d; }
    }
  }
  return best;
}

/**
 * The map as prose-friendly text. view: 'full' (the narrator and map keeper: everything, hidden things marked)
 * or 'player' (the simplifier: only what the player can perceive or knows).
 */
export function mapText(map, playerName = 'You', view = 'full') {
  if (!map.locations.length && !map.entities.some((e) => e.location || e.kind !== 'player')) return '';
  const player = playerEntity(structuredClone(map), playerName);
  const visible = (e) => view === 'full' || !e.hidden;
  const shown = (e) => (view === 'player' && !e.known && e.alias ? e.alias : e.name) + (view === 'full' && !e.known && e.alias ? ` (${playerName} only knows them as "${e.alias}")` : '');
  const lines = [];
  if (map.time || map.weather) lines.push([map.time && `Time: ${map.time}`, map.weather && `Weather: ${map.weather}`].filter(Boolean).join(' · '));
  const here = player.location ? ancestry(map, player.location) : [];
  lines.push(here.length ? `${playerName} is in: ${here.map((l) => l.name).reverse().join(', in ')}` : `${playerName}'s location: unknown`);

  const conn = (l) => map.connections
    .filter((c) => c.a === l.id || c.b === l.id)
    .map((c) => {
      const other = map.locations.find((x) => x.id === (c.a === l.id ? c.b : c.a));
      return other ? `${other.name}${c.kind ? ` (${c.kind})` : ''}` : null;
    })
    .filter(Boolean);
  const walk = (parent, indent) => {
    for (const l of map.locations.filter((x) => (x.parent || null) === parent)) {
      const people = map.entities.filter((e) => e.location === l.id && visible(e)).map((e) => (e.kind === 'player' ? `**${playerName}**` : shown(e)));
      const links = conn(l);
      lines.push(
        `${'  '.repeat(indent)}- ${l.name} [${l.type}]${l.desc ? `: ${l.desc}` : ''}${links.length ? ` | connects to: ${links.join(', ')}` : ''}${people.length ? ` | here: ${people.join(', ')}` : ''}`
      );
      walk(l.id, indent + 1);
    }
  };
  if (map.locations.length) {
    lines.push('LOCATIONS (nested = inside):');
    walk(null, 0);
  }
  const ents = map.entities.filter((e) => visible(e) && (e.kind !== 'player' || e.location || e.outfit || e.inventory?.length || e.condition));
  if (ents.length) {
    lines.push('PEOPLE & THINGS:');
    for (const e of ents) {
      const where = e.location ? map.locations.find((l) => l.id === e.location)?.name : 'unknown location';
      const bits = [
        e.kind !== 'npc' && e.kind !== 'player' && e.kind,
        e.doing && `doing: ${e.doing}`,
        e.outfit && `wearing: ${e.outfit}`,
        e.inventory?.length && `carrying: ${e.inventory.join(', ')}`,
        e.condition && `condition: ${e.condition}`,
        e.attitude && `attitude to ${playerName}: ${e.attitude}`,
        view === 'full' && e.kind !== 'player' && e.kind !== 'object' && `knows about ${playerName}: ${e.knows?.length ? e.knows.join('; ') : 'nothing yet'}`,
        view === 'full' && e.notes && `notes: ${e.notes}`,
        view === 'full' && e.hidden && `HIDDEN — ${playerName} can't perceive them right now`
      ].filter(Boolean);
      lines.push(`- ${e.kind === 'player' ? `${playerName} (the player)` : shown(e)} — ${where}${bits.length ? `; ${bits.join('; ')}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * A short, computed "who can perceive what" check for the end of the narrator's prompt: models lose track of
 * positions and let characters know things they couldn't, and a plain list right before they write fixes most of it.
 */
export function perceptionBrief(map, playerName = 'You') {
  const player = map.entities.find((e) => e.kind === 'player');
  const loc = player?.location && map.locations.find((l) => l.id === player.location);
  if (!loc) return '';
  const nameOf = (id) => map.locations.find((l) => l.id === id)?.name || '?';
  const exits = map.connections.filter((c) => c.a === loc.id || c.b === loc.id).map((c) => ({ id: c.a === loc.id ? c.b : c.a, kind: c.kind }));
  const nearIds = new Set([...exits.map((x) => x.id), ...map.locations.filter((l) => l.parent === loc.id).map((l) => l.id), ...(loc.parent ? [loc.parent] : [])]);
  const people = map.entities.filter((e) => e.kind === 'npc' || e.kind === 'creature');
  const here = people.filter((e) => e.location === loc.id);
  const near = people.filter((e) => e.location && nearIds.has(e.location));
  const far = people.filter((e) => !here.includes(e) && !near.includes(e));
  const things = map.entities.filter((e) => e.kind === 'object' && e.location === loc.id);
  const label = (e) => (e.known === false && e.alias ? `${e.name} (${playerName} only knows them as "${e.alias}")` : e.name);
  const where = ancestry(map, loc.id).map((l) => l.name).reverse().join(', in ');

  const lines = [`SCENE CHECK — where everyone is right now (from the map; trust this over anything earlier):`];
  lines.push(`- ${playerName} is in ${where}.${player.hidden ? ` ${playerName} is HIDDEN: nobody has noticed them unless the story says so.` : ''}${exits.length ? ` Ways out: ${exits.map((x) => `${nameOf(x.id)}${x.kind ? ` (${x.kind})` : ''}`).join(', ')}.` : ''}`);
  lines.push(
    here.length
      ? `- In the same place (can see and hear ${playerName}${player.hidden ? ' if they notice them' : ''}): ${here.map((e) => `${label(e)}${e.doing ? ` — ${e.doing}` : ''}${e.hidden ? ` [HIDDEN: ${playerName} can't see or hear them]` : ''}`).join('; ')}`
      : `- Nobody else is in the same place as ${playerName}.`
  );
  if (things.length) lines.push(`- Things here: ${things.map((t) => `${t.name}${t.doing ? ` (${t.doing})` : ''}`).join(', ')}`);
  if (near.length) lines.push(`- Nearby but NOT here (can't see ${playerName}; at most hear loud noises): ${near.map((e) => `${label(e)} (${nameOf(e.location)})`).join('; ')}`);
  if (far.length) lines.push(`- Out of sight and earshot (can't perceive anything happening here): ${far.slice(0, 12).map((e) => `${e.name}${e.location ? ` (${nameOf(e.location)})` : ''}`).join('; ')}${far.length > 12 ? ` and ${far.length - 12} more` : ''}`);
  const relevant = [...here, ...near];
  if (relevant.length) {
    lines.push(`- What they know about ${playerName} (anything not listed, they DON'T know — not ${playerName}'s name, past, secrets, plans or belongings):`);
    for (const e of relevant) lines.push(`  · ${e.name}: ${e.knows?.length ? e.knows.join('; ') : 'nothing beyond what they can see right now'}`);
  }
  lines.push(`Characters react only to what they can perceive right now and say only what they know and would actually bother saying. Nobody explains, points out or describes things for the player's benefit.`);
  return lines.join('\n');
}

// --- the two AI passes --------------------------------------------------------------------------------

const MAP_KEEPER = (user) => `You are the MAP KEEPER of an interactive story. You maintain a structured map: places (nested: region > area > building > floor > room), how they connect, and where every person and notable object is. The narrator relies on your map to keep positions, distances and line of sight consistent, so be precise.

Read the latest exchange and return ONLY the changes, as JSON: {"ops":[...]}. Operations:
- {"op":"location","name":"...","type":"region|area|building|floor|room|outdoor|landmark|vehicle","parent":"<containing place or null>","x":0-100,"y":0-100,"w":5-60,"h":5-60,"desc":"short physical description"}  (creates or updates; add "rename" to rename)
- {"op":"remove_location","name":"..."}
- {"op":"connect","a":"...","b":"...","kind":"door|hallway|stairs|road|path|window|gate|..."}  /  {"op":"disconnect","a":"...","b":"..."}
- {"op":"entity","name":"...","kind":"npc|creature|object","location":"<most specific place>","doing":"...","outfit":"...","attitude":"how they feel about ${user}","known":true|false,"alias":"what ${user} calls them if they don't know the name","hidden":true|false,"learned":["new facts this character just learned about ${user}"],"notes":"..."}  (creates or updates)
- {"op":"player","location":"...","doing":"...","outfit":"what ${user} is wearing","inventory":["full list of what ${user} carries"],"condition":"injuries, tiredness, mood, effects","hidden":true|false}
- {"op":"remove_entity","name":"..."}   (dead bodies and dropped items stay as entities; remove only what is truly gone)
- {"op":"world","time":"...","weather":"..."}

Rules:
- x,y are the CENTRE of a place inside its parent (0-100; north/up = low y, west/left = low x); w,h its size in % of the parent. Siblings must not overlap. Lay places out the way the story describes them (the kitchen behind the bar, the well in the middle of the square).
- When ${user} enters a new place, sketch it sensibly: the place itself, its obvious exits and the rooms or features the prose mentions. Don't invent far-away places nobody mentioned.
- Always keep ${user}'s location current. Move characters when they move. A character who leaves with no destination goes to the parent place or is removed only if they've left the story.
- "known": false when ${user} hasn't learned who that person is (then set "alias"). "hidden": true when ${user} can't currently see or hear them (hiding, invisible, behind a wall listening).
- Track outfits, items and conditions when they change (put on, taken off, picked up, given away, wounded, drunk...).
- KNOWLEDGE: each character's "knows" list is everything they know about ${user}. When a character sees, hears or is told something about ${user} on-screen (their name, face, job, what they said, did or carry, a secret), add it with "learned", in a few words ("${user}'s name", "${user} is looking for the Grey Heron", "saw ${user} pocket the key"). Only what that character actually witnessed or was told — someone in another room or not paying attention learns nothing. For ${user} set "hidden": true while they're hiding or unseen.
- Use existing names exactly as they appear in the map. If nothing changed, return {"ops":[]}.`;

const SIMPLIFIER = (user) => `You write the SCENE SIMPLIFIER card for the player of an interactive story. The player gets overwhelmed or confused by long, detailed prose and needs the essentials at a glance, in very plain, short, concrete words (simple vocabulary, no metaphors, no flowery language).

Only include what ${user} knows or can perceive — never hidden people, other characters' secret thoughts, or things ${user} hasn't seen. Unknown people are described the way ${user} would ("a tall woman in a red cloak").

Return ONLY JSON:
{"where":"place, in plain words (and the bigger place it's in)",
 "time":"time of day / weather if known, else ''",
 "happening":"1-3 short sentences: what is going on RIGHT NOW",
 "you":{"doing":"...","wearing":"...","carrying":"...","condition":"..."},
 "around":[{"name":"name or description","who":"2-5 words: who they are to ${user}","doing":"short","mood":"one or two words"}],
 "know":["up to 5 important facts: dangers, chances, what changed, clues — one short line each"],
 "asked":"if someone just asked ${user} something or wants something from them, say who and what, plainly; else ''",
 "options":["3 short, different things ${user} could do next"],
 "mood":"one word for the scene's tone"}`;

/** What the narrator said last and what the player did before it. */
function lastExchange(chatId, uptoId, count = 2) {
  return db
    .prepare("SELECT role, content FROM messages WHERE chat_id = ? AND id <= ? AND hidden = 0 AND role != 'system' ORDER BY id DESC LIMIT ?")
    .all(chatId, uptoId, count)
    .reverse();
}

function cast(chatId) {
  return db
    .prepare('SELECT c.name, c.description FROM chat_characters cc JOIN characters c ON c.id = cc.character_id WHERE cc.chat_id = ? ORDER BY cc.position')
    .all(chatId)
    .map((c) => `- ${c.name}: ${c.description.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
}

const transcript = (msgs, user) => msgs.map((m) => `${m.role === 'user' ? user : 'NARRATOR'}: ${m.content}`).join('\n\n');

export async function updateMap(chat, messageId, { playerName, rebuild = false, story = '' } = {}) {
  const s = getSettings();
  const map = loadMap(chat);
  playerEntity(map, playerName);
  const msgs = messageId ? lastExchange(chat.id, messageId, rebuild ? 14 : map.locations.length ? 2 : 4) : [];
  if (!msgs.length && !story.trim()) return { map, log: [] };
  const out = await completeJSON({
    task: 'map',
    model: s.trackerModel || s.utilityModel,
    maxTokens: 2500,
    temperature: 0.2,
    messages: [
      { role: 'system', content: MAP_KEEPER(playerName) },
      {
        role: 'user',
        content: [
          `PLAYER: ${playerName}`,
          cast(chat.id) && `MAIN CHARACTERS:\n${cast(chat.id)}`,
          `CURRENT MAP (JSON):\n${JSON.stringify(compactMap(map))}`,
          `CURRENT MAP (as text):\n${mapText(map, playerName) || '(empty — build it from the story)'}`,
          msgs.length
            ? `${rebuild ? 'STORY SO FAR (rebuild the map so it matches)' : 'LATEST EXCHANGE'}:\n${transcript(msgs, playerName)}`
            : `THE STORY'S STARTING SITUATION (build the opening map from it):\n${story}`
        ].filter(Boolean).join('\n\n')
      }
    ]
  });
  const log = applyOps(map, out.ops || [], playerName);
  return { map, log };
}

/** The map without bookkeeping fields, for the map keeper's input (names instead of ids). */
function compactMap(map) {
  const name = (id) => map.locations.find((l) => l.id === id)?.name || null;
  return {
    time: map.time,
    weather: map.weather,
    locations: map.locations.map((l) => ({ name: l.name, type: l.type, parent: name(l.parent), x: l.x, y: l.y, w: l.w, h: l.h, desc: l.desc })),
    connections: map.connections.map((c) => ({ a: name(c.a), b: name(c.b), kind: c.kind })),
    entities: map.entities.map((e) => {
      const o = { name: e.name, kind: e.kind, location: name(e.location) };
      for (const k of ['alias', 'doing', 'outfit', 'attitude', 'condition', 'notes']) if (e[k]) o[k] = e[k];
      if (e.inventory?.length) o.inventory = e.inventory;
      if (e.knows?.length) o.knows = e.knows;
      if (e.known === false) o.known = false;
      if (e.hidden) o.hidden = true;
      return o;
    })
  };
}

export async function simplifyScene(chat, messageId, { map, playerName, persona }) {
  const s = getSettings();
  const msgs = lastExchange(chat.id, messageId, 3);
  const out = await completeJSON({
    task: 'simplify',
    model: s.simplifierModel || s.utilityModel,
    maxTokens: 900,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SIMPLIFIER(playerName) },
      {
        role: 'user',
        content: [
          `PLAYER CHARACTER: ${playerName}${persona?.description ? `\n${persona.description.slice(0, 1200)}` : ''}`,
          map && mapText(map, playerName, 'player') && `WHAT ${playerName.toUpperCase()} CAN SEE AND KNOWS (map):\n${mapText(map, playerName, 'player')}`,
          `LATEST STORY:\n${transcript(msgs, playerName)}`
        ].filter(Boolean).join('\n\n')
      }
    ]
  });
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n);
  return {
    where: str(out.where),
    time: str(out.time),
    happening: str(out.happening, 600),
    you: {
      doing: str(out.you?.doing),
      wearing: str(out.you?.wearing),
      carrying: str(out.you?.carrying),
      condition: str(out.you?.condition)
    },
    around: list(out.around, 10).map((a) => ({ name: str(a?.name, 80), who: str(a?.who, 80), doing: str(a?.doing, 160), mood: str(a?.mood, 40) })).filter((a) => a.name),
    know: list(out.know, 6).map((k) => str(k, 200)).filter(Boolean),
    asked: str(out.asked, 300),
    options: list(out.options, 4).map((o) => str(o, 120)).filter(Boolean),
    mood: str(out.mood, 30),
    message_id: messageId
  };
}

export function saveSnapshot(chatId, messageId, map, scene) {
  db.prepare(
    `INSERT INTO snapshots (message_id, chat_id, map, scene) VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET map = excluded.map, scene = excluded.scene`
  ).run(messageId, chatId, JSON.stringify(map), JSON.stringify(scene || {}));
}

/** Rewinds the chat's map and scene card to how they were after the last message before `beforeId`. */
export function rewind(chatId, beforeId) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE chat_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT 1').get(chatId, beforeId);
  if (snap) {
    db.prepare('UPDATE chats SET map = ?, scene = ? WHERE id = ?').run(snap.map, snap.scene, chatId);
    return;
  }
  // nothing tracked before it: back to the starting map
  db.prepare("UPDATE chats SET map = base_map, scene = '{}' WHERE id = ?").run(chatId);
}
