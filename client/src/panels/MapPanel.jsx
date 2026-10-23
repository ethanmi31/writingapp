import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AsyncButton, Dots, Field } from '../components.jsx';

const W = 100;
const H = 68;
const TYPES = ['region', 'area', 'building', 'floor', 'room', 'outdoor', 'landmark', 'vehicle'];
const FILL = {
  region: 'rgba(120,130,160,0.10)',
  area: 'rgba(120,130,160,0.14)',
  building: 'rgba(139,123,255,0.16)',
  floor: 'rgba(110,140,220,0.16)',
  room: 'rgba(94,200,255,0.13)',
  outdoor: 'rgba(63,191,127,0.15)',
  landmark: 'rgba(232,184,74,0.18)',
  vehicle: 'rgba(255,138,92,0.16)'
};
const ICON = { region: '🗺', area: '🏘', building: '🏠', floor: '▤', room: '▢', outdoor: '🌲', landmark: '⛯', vehicle: '⛵' };

const hostile = /hostile|angry|furious|aggress|enem|threat|murder|kill|hate|suspicious/i;
const friendly = /friend|ally|warm|fond|love|trust|loyal|kind|affection|happy/i;
function entityColor(e) {
  if (e.kind === 'player') return 'var(--rp)';
  if (e.kind === 'object') return 'var(--muted)';
  if (e.kind === 'creature') return 'var(--warn)';
  if (hostile.test(e.attitude || '')) return 'var(--danger)';
  if (friendly.test(e.attitude || '')) return 'var(--ok)';
  return 'var(--accent-2)';
}

export default function MapPanel({ chat, setChat, notify, tracking, onAction }) {
  const map = chat.map || { locations: [], connections: [], entities: [] };
  const user = chat.names.user;
  const [view, setView] = useState(undefined); // undefined = follow the player
  const [gm, setGm] = useState(false);
  const [sel, setSel] = useState(null); // { type: 'loc' | 'ent', id }
  const svg = useRef(null);
  const drag = useRef(null);
  const [dragTick, setDragTick] = useState(0);

  const byId = useMemo(() => new Map(map.locations.map((l) => [l.id, l])), [map]);
  const ancestry = (id) => {
    const chain = [];
    const seen = new Set();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = byId.get(cur.parent);
    }
    return chain;
  };
  const player = map.entities.find((e) => e.kind === 'player');
  const childrenOf = (id) => map.locations.filter((l) => (l.parent || null) === (id || null));
  const followView = (() => {
    if (!player?.location) return null;
    const chain = ancestry(player.location);
    // show the place the player is in together with its neighbours, unless it's a top-level place
    const here = chain[chain.length - 1];
    return childrenOf(here.id).length ? here.id : chain.length > 1 ? chain[chain.length - 2].id : null;
  })();
  const current = view === undefined ? followView : view;
  useEffect(() => { if (current && !byId.has(current)) setView(undefined); }, [map]);

  const save = async (next) => {
    try {
      const saved = await api.put(`/chats/${chat.id}/map`, { map: next });
      setChat((c) => ({ ...c, map: saved }));
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  // ---- geometry
  const rectOf = (l, box = { x: 0, y: 0, w: W, h: H }) => ({
    x: box.x + ((l.x - l.w / 2) / 100) * box.w,
    y: box.y + ((l.y - l.h / 2) / 100) * box.h,
    w: (l.w / 100) * box.w,
    h: (l.h / 100) * box.h
  });
  const kids = childrenOf(current);
  const rects = new Map(); // location id -> rect, for children and grandchildren in view
  for (const c of kids) {
    const r = rectOf(c);
    rects.set(c.id, r);
    for (const g of childrenOf(c.id)) rects.set(g.id, rectOf(g, r));
  }
  const viewBox = { x: 0, y: 0, w: W, h: H };
  const visible = (e) => gm || !e.hidden;

  // where each entity is drawn: inside the deepest visible place on its path
  const placed = [];
  const elsewhere = [];
  const boxes = new Map();
  for (const e of map.entities.filter(visible)) {
    if (!e.location && e.kind !== 'player') { elsewhere.push(e); continue; }
    const chain = e.location ? ancestry(e.location).map((l) => l.id) : [];
    if (current && !chain.includes(current)) { elsewhere.push(e); continue; }
    const rest = current ? chain.slice(chain.indexOf(current) + 1) : chain;
    const boxId = rest.length >= 2 && rects.has(rest[1]) ? rest[1] : rest.length ? rest[0] : current || '__root';
    if (!e.location && e.kind === 'player') { elsewhere.push(e); continue; }
    if (!boxes.has(boxId)) boxes.set(boxId, []);
    boxes.get(boxId).push(e);
  }
  for (const [boxId, list] of boxes) {
    const r = rects.get(boxId) || viewBox;
    const direct = boxId === (current || '__root');
    const n = list.length;
    const cols = Math.ceil(Math.sqrt(n * (r.w / Math.max(r.h, 1))));
    const rows = Math.ceil(n / cols);
    list.forEach((e, i) => {
      const exact = e.location === (boxId === '__root' ? null : boxId) && e.x != null && e.y != null;
      const x = exact ? r.x + (e.x / 100) * r.w : r.x + ((i % cols) + 0.5) * (r.w / cols);
      const y = exact ? r.y + (e.y / 100) * r.h : direct && !rects.has(boxId) ? r.y + r.h - 6 - Math.floor(i / cols) * 6 : r.y + r.h * 0.42 + (Math.floor(i / cols) + 0.5) * ((r.h * 0.55) / rows);
      placed.push({ e, x, y, boxId });
    });
  }

  // connections between what's visible (and to places outside the view, as edge stubs)
  const rep = (id) => {
    const chain = ancestry(id).map((l) => l.id);
    if (current && !chain.includes(current)) return null;
    const rest = current ? chain.slice(chain.indexOf(current) + 1) : chain;
    if (!rest.length) return null;
    return rest.length >= 2 && rects.has(rest[1]) ? rest[1] : rest[0];
  };
  const lines = [];
  const seenPairs = new Set();
  for (const c of map.connections) {
    const a = rep(c.a);
    const b = rep(c.b);
    if (a && b && a !== b) {
      const key = [a, b].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const ra = rects.get(a);
      const rb = rects.get(b);
      lines.push({ key, x1: ra.x + ra.w / 2, y1: ra.y + ra.h / 2, x2: rb.x + rb.w / 2, y2: rb.y + rb.h / 2, kind: c.kind });
    } else if ((a && !b) || (!a && b)) {
      const inside = rects.get(a || b);
      const other = byId.get(a ? c.b : c.a);
      if (!inside || !other || ancestry(other.id).some((l) => l.id === (a ? c.a : c.b))) continue;
      const cx = inside.x + inside.w / 2;
      const cy = inside.y + inside.h / 2;
      const dists = [cx, W - cx, cy, H - cy];
      const side = dists.indexOf(Math.min(...dists));
      const [x2, y2] = [[1, cy], [W - 1, cy], [cx, 1], [cx, H - 1]][side];
      lines.push({ key: `${c.a}-${c.b}`, x1: cx, y1: cy, x2, y2, kind: c.kind, stub: other.name });
    }
  }

  const playerChain = player?.location ? ancestry(player.location).map((l) => l.id) : [];
  const crumbs = current ? ancestry(current) : [];

  // ---- pointer handling: click to select, double-click to zoom, drag to move
  const toSvg = (ev) => {
    const pt = svg.current.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.current.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  const startDrag = (ev, item) => {
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    drag.current = { ...item, start: toSvg(ev), moved: false, dx: 0, dy: 0 };
  };
  const onMove = (ev) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(ev);
    d.dx = p.x - d.start.x;
    d.dy = p.y - d.start.y;
    if (Math.hypot(d.dx, d.dy) > 0.8) d.moved = true;
    if (d.moved) setDragTick((t) => t + 1);
  };
  const onUp = (ev) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      setSel({ type: d.type, id: d.id });
      return;
    }
    const next = structuredClone(map);
    if (d.type === 'loc') {
      const l = next.locations.find((x) => x.id === d.id);
      const parentBox = l.parent && rects.has(l.parent) && l.parent !== current ? rects.get(l.parent) : viewBox;
      l.x = Math.max(l.w / 2, Math.min(100 - l.w / 2, l.x + (d.dx / parentBox.w) * 100));
      l.y = Math.max(l.h / 2, Math.min(100 - l.h / 2, l.y + (d.dy / parentBox.h) * 100));
    } else {
      // dropped somewhere: the deepest place under the pointer becomes the entity's location
      const p = toSvg(ev);
      const e = next.entities.find((x) => x.id === d.id);
      const hits = [...rects.entries()].filter(([, r]) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
      const target = hits.length ? hits[hits.length - 1] : null; // grandchildren come after their parent
      const box = target ? target[1] : viewBox;
      e.location = target ? target[0] : current || e.location;
      e.x = Math.round(((p.x - box.x) / box.w) * 100);
      e.y = Math.round(((p.y - box.y) / box.h) * 100);
    }
    save(next);
  };
  const dragOffset = (type, id) => (drag.current?.moved && drag.current.type === type && drag.current.id === id ? `translate(${drag.current.dx} ${drag.current.dy})` : undefined);

  const zoomInto = (id) => {
    setView(id);
    setSel(null);
  };

  const addLocation = () => {
    const next = structuredClone(map);
    const id = `l${Date.now().toString(36)}`;
    next.locations.push({ id, name: 'New place', type: 'room', parent: current || null, x: null, y: null, w: null, h: null, desc: '' });
    save(next).then(() => setSel({ type: 'loc', id }));
  };
  const addEntity = () => {
    const next = structuredClone(map);
    const id = `e${Date.now().toString(36)}`;
    next.entities.push({ id, kind: 'npc', name: 'Someone', location: current || null, known: true, hidden: false, alias: '', doing: '', outfit: '', attitude: '', notes: '' });
    save(next).then(() => setSel({ type: 'ent', id }));
  };

  const empty = !map.locations.length;
  return (
    <div className="map-wrap">
      <div className="pane-title">
        <span>🗺 Map</span>
        {(map.time || map.weather) && <span className="badge" style={{ textTransform: 'none', letterSpacing: 0 }}>{[map.time, map.weather].filter(Boolean).join(' · ')}</span>}
        <span className="grow" />
        {tracking && <span className="tiny" style={{ textTransform: 'none' }}>updating <Dots /></span>}
      </div>
      {empty ? (
        <div className="callout small">
          No map yet. It draws itself as the story goes: every reply, the map keeper places locations, people and objects.
          <div className="row" style={{ marginTop: 8 }}>
            <AsyncButton className="small" notify={notify} busyLabel="Building…" onClick={async () => {
              const r = await api.post(`/chats/${chat.id}/map/rebuild`, { fresh: false });
              setChat((c) => ({ ...c, map: r.map }));
            }}>Build from {chat.messages.length ? 'the story so far' : 'the scenario'}</AsyncButton>
            <button className="small" onClick={addLocation}>＋ Add a place by hand</button>
          </div>
        </div>
      ) : (
        <>
          <div className="map-crumbs">
            <button className={`ghost ${!current ? 'active' : ''}`} onClick={() => zoomInto(null)}>World</button>
            {crumbs.map((l) => (
              <span key={l.id} className="row" style={{ gap: 4 }}>
                <span className="muted">›</span>
                <button className="ghost" onClick={() => zoomInto(l.id)}>{l.name}</button>
              </span>
            ))}
            <span className="grow" />
            {view !== undefined && player?.location && <button className="small" title="Follow your character" onClick={() => setView(undefined)}>📍 Me</button>}
          </div>
          <svg ref={svg} className="map-svg" viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { if (drag.current?.moved) setDragTick((t) => t + 1); }} onClick={(e) => e.target === svg.current && setSel(null)} data-tick={dragTick}>
            <defs>
              <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="var(--border)" strokeWidth="0.08" />
              </pattern>
            </defs>
            <rect x="0" y="0" width={W} height={H} fill="url(#grid)" pointerEvents="none" />
            {lines.map((l) => (
              <g key={l.key} pointerEvents="none">
                <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="var(--muted)" strokeWidth="0.35" strokeDasharray={l.stub ? '1 0.8' : l.kind === 'door' ? undefined : '0.6 0.6'} opacity="0.75" />
                {(l.stub || l.kind) && (
                  <text x={l.stub ? l.x2 + (l.x2 > W / 2 ? -1 : 1) : (l.x1 + l.x2) / 2} y={l.stub ? l.y2 + (l.y2 > H / 2 ? -1 : 2.4) : (l.y1 + l.y2) / 2 - 0.6} fontSize="1.9" fill="var(--muted)" textAnchor={l.stub ? (l.x2 > W / 2 ? 'end' : 'start') : 'middle'}>
                    {l.stub ? `→ ${l.stub}` : l.kind}
                  </text>
                )}
              </g>
            ))}
            {kids.map((c) => {
              const r = rects.get(c.id);
              const here = playerChain.includes(c.id);
              const selected = sel?.type === 'loc' && sel.id === c.id;
              const grand = childrenOf(c.id);
              return (
                <g key={c.id} className="map-loc" transform={dragOffset('loc', c.id)}>
                  <rect
                    x={r.x} y={r.y} width={r.w} height={r.h} rx="1.4"
                    fill={FILL[c.type] || FILL.room}
                    stroke={selected ? 'var(--accent)' : here ? 'var(--rp)' : 'var(--border)'}
                    strokeWidth={selected || here ? 0.5 : 0.25}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => startDrag(e, { type: 'loc', id: c.id })}
                    onDoubleClick={() => grand.length && zoomInto(c.id)}
                  />
                  <text x={r.x + 1} y={r.y + 2.7} fontSize={Math.max(1.8, Math.min(2.6, r.w / 9))} fill="var(--text)" fontWeight="600">
                    {ICON[c.type] || ''} {c.name.length > r.w / 1.3 ? `${c.name.slice(0, Math.max(4, Math.floor(r.w / 1.3)))}…` : c.name}
                  </text>
                  {grand.map((g) => {
                    const gr = rects.get(g.id);
                    const gHere = playerChain.includes(g.id);
                    const gSel = sel?.type === 'loc' && sel.id === g.id;
                    return (
                      <g key={g.id} transform={dragOffset('loc', g.id)}>
                        <rect x={gr.x} y={gr.y} width={gr.w} height={gr.h} rx="0.8" fill={FILL[g.type] || FILL.room} stroke={gSel ? 'var(--accent)' : gHere ? 'var(--rp)' : 'var(--border)'} strokeWidth={gSel || gHere ? 0.4 : 0.18} style={{ cursor: 'grab' }}
                          onPointerDown={(e) => startDrag(e, { type: 'loc', id: g.id })}
                          onDoubleClick={() => zoomInto(c.id)} />
                        {gr.w > 7 && <text x={gr.x + 0.6} y={gr.y + 2} fontSize={Math.max(1.4, Math.min(1.9, gr.w / 8))} fill="var(--muted)">{g.name.length > gr.w / 1.1 ? `${g.name.slice(0, Math.max(3, Math.floor(gr.w / 1.1)))}…` : g.name}</text>}
                      </g>
                    );
                  })}
                  {grand.length > 0 && <text x={r.x + r.w - 1} y={r.y + 2.6} fontSize="1.8" fill="var(--muted)" textAnchor="end" style={{ cursor: 'pointer' }} pointerEvents="all" onClick={() => zoomInto(c.id)}>⤢</text>}
                </g>
              );
            })}
            {placed.map(({ e, x, y }) => {
              const color = entityColor(e);
              const selected = sel?.type === 'ent' && sel.id === e.id;
              const label = !e.known && e.alias ? e.alias : e.name;
              return (
                <g key={e.id} className="map-ent" transform={dragOffset('ent', e.id)} style={{ cursor: 'grab' }} onPointerDown={(ev) => startDrag(ev, { type: 'ent', id: e.id })} opacity={e.hidden ? 0.55 : 1}>
                  {e.kind === 'player' && <circle cx={x} cy={y} r="2.6" fill="none" stroke={color} strokeWidth="0.3" opacity="0.6"><animate attributeName="r" values="1.8;3;1.8" dur="2.4s" repeatCount="indefinite" /></circle>}
                  {e.kind === 'object' ? (
                    <rect x={x - 1} y={y - 1} width="2" height="2" rx="0.3" fill={color} stroke={selected ? 'var(--text)' : 'none'} strokeWidth="0.3" />
                  ) : (
                    <circle cx={x} cy={y} r={e.kind === 'player' ? 1.6 : 1.3} fill={color} stroke={selected ? 'var(--text)' : e.hidden ? 'var(--text)' : 'var(--panel)'} strokeWidth="0.3" strokeDasharray={e.hidden ? '0.4 0.3' : undefined} />
                  )}
                  <text x={x} y={y + 3.4} fontSize="1.85" fill="var(--text)" textAnchor="middle" fontWeight={e.kind === 'player' ? 700 : 500} paintOrder="stroke" stroke="var(--panel-2)" strokeWidth="0.5">
                    {e.kind === 'player' ? `${label} (you)` : label.length > 16 ? `${label.slice(0, 15)}…` : label}
                  </text>
                </g>
              );
            })}
            {!kids.length && current && <text x={W / 2} y={H / 2} fontSize="2.4" fill="var(--muted)" textAnchor="middle">Nothing mapped inside {byId.get(current)?.name} yet</text>}
          </svg>
          <div className="map-legend">
            <span><i className="legend-dot" style={{ background: 'var(--rp)' }} />you</span>
            <span><i className="legend-dot" style={{ background: 'var(--accent-2)' }} />neutral</span>
            <span><i className="legend-dot" style={{ background: 'var(--ok)' }} />friendly</span>
            <span><i className="legend-dot" style={{ background: 'var(--danger)' }} />hostile</span>
            <span><i className="legend-dot" style={{ background: 'var(--muted)', borderRadius: 2 }} />object</span>
            <span className="grow" />
            <span>drag to move · double-click to open</span>
          </div>
          {elsewhere.filter((e) => e.kind !== 'object').length > 0 && (
            <div className="map-elsewhere">
              Elsewhere:{' '}
              {elsewhere.filter((e) => e.kind !== 'object').map((e, i) => {
                const where = e.location ? byId.get(e.location)?.name : 'unknown';
                return (
                  <span key={e.id}>
                    {i > 0 && ', '}
                    <a onClick={() => { setSel({ type: 'ent', id: e.id }); if (e.location) setView(byId.get(e.location)?.parent || null); }}>{!e.known && e.alias ? e.alias : e.name}</a> ({where})
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
      <div className="map-tools">
        {!empty && <button onClick={addLocation}>＋ Place</button>}
        <button onClick={addEntity}>＋ Person / thing</button>
        <button className={gm ? 'active' : ''} onClick={() => setGm(!gm)} title="Show people and things your character can't currently perceive (spoilers!)">{gm ? '👁 GM view on' : '👁 GM view'}</button>
        {!empty && (
          <>
            <AsyncButton notify={notify} busyLabel="Tidying…" title="Re-arrange places so nothing overlaps" onClick={async () => {
              const saved = await api.put(`/chats/${chat.id}/map`, { map, relayout: 'all' });
              setChat((c) => ({ ...c, map: saved }));
            }}>⊞ Tidy</AsyncButton>
            <AsyncButton notify={notify} busyLabel="Rebuilding…" title="Ask the map keeper to re-check the whole map against the recent story" onClick={async () => {
              const r = await api.post(`/chats/${chat.id}/map/rebuild`, { fresh: false });
              setChat((c) => ({ ...c, map: r.map }));
              notify(r.log.length ? `Map updated: ${r.log.slice(0, 6).join(', ')}${r.log.length > 6 ? '…' : ''}` : 'The map already matched the story');
            }}>↻ Re-sync</AsyncButton>
            <button className="danger" onClick={() => { if (confirm('Clear the whole map? It will rebuild as the story continues.')) save({ locations: [], connections: [], entities: map.entities.filter((e) => e.kind === 'player').map((e) => ({ ...e, location: null })), time: '', weather: '' }); }}>Clear</button>
          </>
        )}
      </div>
      {sel && <Detail key={`${sel.type}${sel.id}`} sel={sel} map={map} user={user} save={save} close={() => setSel(null)} onAction={onAction} zoomInto={zoomInto} childrenOf={childrenOf} />}
    </div>
  );
}

function Detail({ sel, map, user, save, close, onAction, zoomInto, childrenOf }) {
  const isLoc = sel.type === 'loc';
  const item = isLoc ? map.locations.find((l) => l.id === sel.id) : map.entities.find((e) => e.id === sel.id);
  const [d, setD] = useState(() => (item ? { ...item, inventory: (item.inventory || []).join(', '), knowsText: (item.knows || []).join('; ') } : null));
  const [editing, setEditing] = useState(false);
  if (!item || !d) return null;
  const set = (k) => (e) => setD({ ...d, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const locName = (id) => map.locations.find((l) => l.id === id)?.name || '—';
  const commit = () => {
    const next = structuredClone(map);
    const list = isLoc ? next.locations : next.entities;
    const i = list.findIndex((x) => x.id === item.id);
    const clean = { ...d };
    if (!isLoc) clean.inventory = d.inventory.split(',').map((s) => s.trim()).filter(Boolean);
    if (!isLoc) clean.knows = d.knowsText.split(';').map((s) => s.trim()).filter(Boolean);
    delete clean.knowsText;
    if (isLoc) clean.parent = d.parent || null;
    else clean.location = d.location || null;
    list[i] = clean;
    save(next);
    setEditing(false);
  };
  const remove = () => {
    const next = structuredClone(map);
    if (isLoc) {
      for (const l of next.locations) if (l.parent === item.id) l.parent = item.parent || null;
      for (const e of next.entities) if (e.location === item.id) e.location = item.parent || null;
      next.locations = next.locations.filter((l) => l.id !== item.id);
      next.connections = next.connections.filter((c) => c.a !== item.id && c.b !== item.id);
    } else {
      next.entities = next.entities.filter((e) => e.id !== item.id);
    }
    save(next);
    close();
  };
  const descendants = new Set();
  if (isLoc) {
    const walk = (id) => { for (const c of map.locations.filter((l) => l.parent === id)) { descendants.add(c.id); walk(c.id); } };
    walk(item.id);
  }
  const label = !isLoc && !item.known && item.alias ? `${item.alias} (${item.name})` : item.name;

  return (
    <div className="map-detail">
      <div className="row space">
        <b>{isLoc ? `${ICON[item.type] || ''} ${item.name}` : item.kind === 'player' ? `${user} (you)` : label}</b>
        <span className="row">
          {!editing && <button className="small ghost" onClick={() => setEditing(true)}>✎ Edit</button>}
          <button className="small ghost" onClick={close}>✕</button>
        </span>
      </div>
      {!editing ? (
        <div className="small" style={{ marginTop: 4, lineHeight: 1.5 }}>
          {isLoc ? (
            <>
              <div className="muted">{item.type}{item.parent ? ` in ${locName(item.parent)}` : ''}</div>
              {item.desc && <p>{item.desc}</p>}
              {map.connections.filter((c) => c.a === item.id || c.b === item.id).length > 0 && (
                <div className="muted">Connects to: {map.connections.filter((c) => c.a === item.id || c.b === item.id).map((c) => `${locName(c.a === item.id ? c.b : c.a)}${c.kind ? ` (${c.kind})` : ''}`).join(', ')}</div>
              )}
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button className="small" onClick={() => onAction(`*I head to the ${item.name}.*`)}>🚶 Go here</button>
                {childrenOf(item.id).length > 0 && <button className="small" onClick={() => zoomInto(item.id)}>⤢ Look inside</button>}
              </div>
            </>
          ) : (
            <>
              <div className="muted">{item.kind}{item.location ? ` · in ${locName(item.location)}` : ''}{item.hidden ? ' · hidden from you' : ''}{!item.known ? ' · name unknown to you' : ''}</div>
              {item.doing && <div>Doing: {item.doing}</div>}
              {item.outfit && <div>Wearing: {item.outfit}</div>}
              {item.inventory?.length > 0 && <div>Carrying: {item.inventory.join(', ')}</div>}
              {item.condition && <div>Condition: {item.condition}</div>}
              {item.attitude && <div>Attitude: {item.attitude}</div>}
              {item.kind !== 'player' && item.kind !== 'object' && <div>Knows about you: {item.knows?.length ? item.knows.join('; ') : <span className="muted">nothing yet</span>}</div>}
              {item.notes && <div className="muted">Notes: {item.notes}</div>}
              {item.kind !== 'player' && item.kind !== 'object' && (
                <div className="row wrap" style={{ marginTop: 8 }}>
                  <button className="small" onClick={() => onAction(`*I walk over to ${!item.known && item.alias ? `the ${item.alias}` : item.name}.*`)}>🚶 Approach</button>
                </div>
              )}
              {item.kind === 'object' && <div className="row" style={{ marginTop: 8 }}><button className="small" onClick={() => onAction(`*I take a closer look at the ${item.name}.*`)}>🔍 Examine</button></div>}
            </>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="grid2">
            <Field label="Name"><input value={d.name} onChange={set('name')} /></Field>
            {isLoc ? (
              <Field label="Type"><select value={d.type} onChange={set('type')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            ) : (
              <Field label="Kind">
                <select value={d.kind} onChange={set('kind')} disabled={item.kind === 'player'}>
                  {(item.kind === 'player' ? ['player'] : ['npc', 'creature', 'object']).map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
            )}
          </div>
          {isLoc ? (
            <>
              <Field label="Inside">
                <select value={d.parent || ''} onChange={set('parent')}>
                  <option value="">— the world —</option>
                  {map.locations.filter((l) => l.id !== item.id && !descendants.has(l.id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
              <Field label="Description"><textarea rows={2} value={d.desc || ''} onChange={set('desc')} /></Field>
            </>
          ) : (
            <>
              <Field label="Where">
                <select value={d.location || ''} onChange={set('location')}>
                  <option value="">— unknown —</option>
                  {map.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
              <Field label="Doing"><input value={d.doing || ''} onChange={set('doing')} /></Field>
              <Field label="Wearing"><input value={d.outfit || ''} onChange={set('outfit')} /></Field>
              {item.kind === 'player' ? (
                <>
                  <Field label="Carrying (comma-separated)"><input value={d.inventory} onChange={set('inventory')} /></Field>
                  <Field label="Condition"><input value={d.condition || ''} onChange={set('condition')} /></Field>
                </>
              ) : (
                <>
                  <Field label={`Attitude to ${user}`}><input value={d.attitude || ''} onChange={set('attitude')} /></Field>
                  <div className="grid2">
                    <label className="toggle"><input type="checkbox" checked={!d.known} onChange={(e) => setD({ ...d, known: !e.target.checked })} /> {user} doesn't know who this is</label>
                    <label className="toggle"><input type="checkbox" checked={!!d.hidden} onChange={set('hidden')} /> Hidden from {user}</label>
                  </div>
                  {!d.known && <Field label={`What ${user} calls them`}><input value={d.alias || ''} onChange={set('alias')} placeholder="the hooded stranger" /></Field>}
                  <Field label={`What they know about ${user} (separate with ;)`}><input value={d.knowsText} onChange={set('knowsText')} placeholder={`${user}'s name; ${user} is a courier`} /></Field>
                  <Field label="Secret notes (narrator only)"><input value={d.notes || ''} onChange={set('notes')} /></Field>
                </>
              )}
            </>
          )}
          <div className="row">
            <button className="primary small" onClick={commit}>Save</button>
            <button className="small" onClick={() => setEditing(false)}>Cancel</button>
            <span className="grow" />
            {item.kind !== 'player' && <button className="small danger" onClick={remove}>Delete</button>}
          </div>
        </div>
      )}
    </div>
  );
}
