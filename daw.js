// Live 12-style Arrangement View: control bar, browser, Info View, track lanes with headers, return tracks,
// Arrangement Mixer, Device View and status bar. Mixer changes on the study tracks go through core.applyAction
// so the study can score them; every edit is logged via onEvent and can be undone.
import { defaultState, clone, applyAction, applyCalls, describeChanges, resolveTrack, parsePan, fmtVol, fmtPan, VOL_MIN, VOL_MAX } from './core.js';
import { createEngine, DEVICES, SOUNDS, SAMPLES, deviceDefaults, fmtParam } from './audio.js';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, cls, props = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, props);
const info = (el, title, text) => { el.dataset.it = title; el.dataset.ih = text; return el; };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const HDR = 268, BARS_MIN = 32, FADER_H = 100;
const PALETTE = ['#ff94a6', '#ffa529', '#cc9927', '#f7f47c', '#bffb00', '#1aff2f', '#25ffa8', '#5cffe8', '#8bc5ff', '#5480e4', '#92a7ff', '#d86ce4', '#e553a0', '#ffffff',
  '#ff3636', '#f66c03', '#99724b', '#fff034', '#87ff67', '#3dc300', '#00bfaf', '#19e9ff', '#10a4ee', '#007dc0', '#886ce4', '#b677c6', '#ff39d4', '#d0d0d0'];
// Demo content for the 8 study tracks, by position: part, clips [start bar, length], devices and sends [A, B].
const TEMPLATE = [
  { sound: 'kick', clips: [[4, 8], [12, 12]], devices: [], sends: [] },
  { sound: 'snare', clips: [[4, 8], [12, 12]], devices: [['Compressor']], sends: [-20] },
  { sound: 'hats', clips: [[0, 24]], devices: [], sends: [] },
  { sound: 'bass', clips: [[4, 20]], devices: [['Saturator', { Drive: 4 }]], sends: [] },
  { sound: 'keys', clips: [[0, 12]], devices: [['EQ Eight']], sends: [VOL_MIN, -20] },
  { sound: 'pad', clips: [[0, 8], [12, 12]], devices: [['Reverb', { 'Dry/Wet': 35 }]], sends: [-12] },
  { sound: 'lead', clips: [[4, 16]], devices: [['Compressor'], ['Delay', { 'Dry/Wet': 15 }]], sends: [-15, -18] },
  { sound: 'choir', clips: [[12, 8]], devices: [['Reverb', { 'Dry/Wet': 40, Decay: 3 }]], sends: [-10] },
];
const GRIDS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8]; // fixed grid sizes, in bars
const ADAPTIVE = [['Narrowest', 6], ['Narrow', 12], ['Medium', 24], ['Wide', 48], ['Widest', 96]]; // adaptive: smallest line spacing in px
const gridName = g => (g >= 1 ? `${g} Bar${g > 1 ? 's' : ''}` : `1/${Math.round(1 / g)}`);
const tidy = x => Math.round(x * 1e6) / 1e6;
const parsePos = (s, len = false) => { // "5", "5.2" or "5.2.3" (bar.beat.sixteenth) -> bars; lengths count from 0
  const [b = 0, bt = len ? 0 : 1, x = len ? 0 : 1] = String(s).split(/[.\s]+/).filter(Boolean).map(Number);
  return len ? b + bt / 4 + x / 16 : b - 1 + (bt - 1) / 4 + (x - 1) / 16;
};
const CATEGORIES = ['Sounds', 'Drums', 'Instruments', 'Audio Effects', 'MIDI Effects', 'Plug-Ins', 'Clips', 'Samples'];
const CAT_INFO = {
  'Audio Effects': 'Live\'s built-in audio effects (plug-ins). Drag one onto a track, or double-click it to add it to the selected track.',
  Samples: 'Audio loops. Click one to preview it. Drag it onto a track to add a clip there, or into "Drop Files and Devices Here" (or double-click it) to create a new audio track with it.',
};

// Fader law shared by faders, volume fields and meters: 0 dB sits near 80% of the travel, like Live.
const dbToPos = db => (db <= VOL_MIN ? 0 : ((db - VOL_MIN) / (VOL_MAX - VOL_MIN)) ** 2.5);
const posToDb = p => (p <= 0.002 ? VOL_MIN : Math.round((VOL_MIN + (VOL_MAX - VOL_MIN) * p ** 0.4) * 10) / 10);
const parseDb = v => { const s = String(v).trim().toLowerCase().replace(/\s*db$/, ''); return s === '-inf' ? VOL_MIN : parseFloat(s); };
const fmtPos = (bars, len = false) => {
  const s = Math.round(bars * 16), b = Math.floor(s / 16), bt = Math.floor((s % 16) / 4), x = s % 4;
  return len ? `${b}. ${bt}. ${x}` : `${b + 1}. ${bt + 1}. ${x + 1}`;
};
const coreOf = t => ({ name: t.name, color: t.color, vol: t.vol, pan: t.pan, on: t.on, solo: t.solo, arm: t.arm });

let seq = 0;
const uid = p => `${p}${++seq}`;
const newDevice = (type, over = {}) => ({ id: uid('d'), type, on: true, params: { ...deviceDefaults(type), ...over } });
const newTrack = (name, color) => ({ id: uid('t'), name, color, vol: 0, pan: 0, on: true, solo: false, arm: false, sends: { A: VOL_MIN, B: VOL_MIN }, clips: [], devices: [] });
function hydrate(core) {
  const s = clone(core);
  s.main ??= { vol: 0 };
  s.returns ??= [
    { id: 'A', name: 'A Reverb', color: '#92a7ff', vol: 0, pan: 0, on: true, solo: false, devices: [newDevice('Reverb', { 'Dry/Wet': 100, Decay: 2.5 })] },
    { id: 'B', name: 'B Delay', color: '#5cffe8', vol: 0, pan: 0, on: true, solo: false, devices: [newDevice('Delay', { 'Dry/Wet': 100 })] },
  ];
  s.tracks.forEach((t, i) => {
    const tp = TEMPLATE[i] ?? { sound: null, clips: [], devices: [], sends: [] };
    t.id ??= uid('t');
    t.sends ??= { A: tp.sends[0] ?? VOL_MIN, B: tp.sends[1] ?? VOL_MIN };
    t.clips ??= tp.clips.map(([start, len]) => ({ id: uid('c'), name: t.name, start, len, offset: start, sound: tp.sound, on: true }));
    t.devices ??= tp.devices.map(([type, over]) => newDevice(type, over));
  });
  return s;
}

// One bar of a clip's waveform, drawn from the part's step pattern and repeated along the clip.
const waveCache = {};
function wave(sound) {
  const key = sound ?? 'none';
  if (waveCache[key]) return waveCache[key];
  const W = 128, H = 32, cv = h('canvas', '', { width: W, height: H }), g = cv.getContext('2d'), S = SOUNDS[sound];
  g.fillStyle = 'rgba(0,0,0,.55)';
  for (let x = 0; x < W; x++) {
    const s = (x / W) * 16;
    let a = 0.03;
    if (S) for (const st of S.steps) if (s >= st) a = Math.max(a, Math.exp(-(s - st) / S.decay));
    a *= 0.6 + 0.4 * ((((Math.sin(x * 12.9898) * 43758.5453) % 1) + 1) % 1);
    const y = Math.max(0.5, a * (H / 2 - 1));
    g.fillRect(x, H / 2 - y, 1, y * 2);
  }
  return (waveCache[key] = cv.toDataURL());
}

function knobSvg(p, center) {
  const r = 11, pt = ang => `${(15 + r * Math.sin(ang)).toFixed(2)} ${(15 - r * Math.cos(ang)).toFixed(2)}`;
  const a = ((p * 270 - 135) * Math.PI) / 180, a0 = center ? 0 : (-135 * Math.PI) / 180;
  const arc = Math.abs(a - a0) > 0.01 ? `<path class="arc" d="M${pt(a0)} A${r} ${r} 0 ${Math.abs(a - a0) > Math.PI ? 1 : 0} ${a > a0 ? 1 : 0} ${pt(a)}"/>` : '';
  return h('div', 'knob', { innerHTML: `<svg viewBox="0 0 30 30"><path class="ring" d="M${pt(-2.356)} A${r} ${r} 0 1 1 ${pt(2.356)}"/>${arc}<line class="ptr" x1="15" y1="15" x2="${15 + 9 * Math.sin(a)}" y2="${15 - 9 * Math.cos(a)}"/></svg>` });
}

export function createDaw({ onEvent = () => {} } = {}) {
  let state = hydrate(defaultState()), loaded = [];
  const T = { loop: false, loopStart: 4, loopEnd: 12, metro: false, follow: true, marker: 0, stopPos: 0, rec: null };
  const view = { ppb: 40, browser: true, info: true, detail: true, mixer: false, cat: 'Audio Effects', search: '', item: null, folded: new Set(),
    grid: { mode: 'adaptive', level: 2, fixed: 3, triplet: false, snap: true } };
  // range: a time selection { start, end, tracks: [ids] } made by dragging across tracks
  let sel = { tracks: new Set(), anchor: null, clip: null, device: null, range: null };
  const undo = [], redo = [];
  const engine = createEngine({ getState: () => state, getTransport: () => T });
  const work = $('#work'), scroller = $('#arrScroll'), inner = $('#arrInner'), devicesEl = $('#devices'), stripsEl = $('#strips');
  let meters = new Map(), playhead = null, markerEl = null, drag = null, lastDown = {}, clipboard = null;

  const byId = id => state.tracks.find(t => t.id === id);
  const ret = id => state.returns.find(r => r.id === id);
  const anyById = id => byId(id) ?? ret(id);
  const idx = id => state.tracks.findIndex(t => t.id === id);
  const where = id => (ret(id) ? `Return ${id}` : idx(id) + 1);
  const selIds = () => state.tracks.filter(t => sel.tracks.has(t.id)).map(t => t.id);
  const current = () => anyById(sel.anchor) ?? byId(selIds()[0]);
  const insertAt = () => { const last = Math.max(-1, ...selIds().map(idx)); return last >= 0 ? last + 1 : state.tracks.length; };
  const nextColor = () => PALETTE[(state.tracks.length * 5 + seq) % PALETTE.length];
  let msgTimer;
  const status = text => { $('#statusMsg').textContent = text; clearTimeout(msgTimer); msgTimer = setTimeout(() => ($('#statusMsg').textContent = ''), 5000); };
  const addMeter = (id, el) => meters.set(id, [...(meters.get(id) ?? []), el]);
  const allIds = () => state.tracks.map(t => t.id);

  // ---------- grid ----------
  function gridSize() {
    const G = view.grid, g = G.mode === 'adaptive' ? GRIDS.find(x => x * view.ppb >= ADAPTIVE[G.level][1]) ?? 8 : GRIDS[G.fixed];
    return G.triplet ? (g * 2) / 3 : g;
  }
  const gridLabel = () => `${gridName(view.grid.triplet ? gridSize() * 1.5 : gridSize())}${view.grid.triplet ? 'T' : ''}${view.grid.snap ? '' : ' (Snap Off)'}`;
  const snapX = (x, free) => tidy(view.grid.snap && !free ? Math.round(x / gridSize()) * gridSize() : x);
  const narrowGrid = g => (g.mode === 'adaptive' ? (g.level = Math.max(0, g.level - 1)) : (g.fixed = Math.max(0, g.fixed - 1)));
  const widenGrid = g => (g.mode === 'adaptive' ? (g.level = Math.min(ADAPTIVE.length - 1, g.level + 1)) : (g.fixed = Math.min(GRIDS.length - 1, g.fixed + 1)));
  function setGrid(fn) { fn(view.grid); onEvent('view', { grid: gridLabel() }); status(`Grid: ${gridLabel()}`); render(); }

  // ---------- edits, undo ----------
  // A snapshot holds the session plus the loop and metronome settings, so undo also restores those.
  const snap = () => JSON.stringify({ s: state, t: { loop: T.loop, loopStart: T.loopStart, loopEnd: T.loopEnd, metro: T.metro } });
  function finish(before, label, ev) {
    if (snap() === before) return render();
    undo.push({ s: before, label }); if (undo.length > 200) undo.shift();
    redo.length = 0;
    if (ev) onEvent(...ev);
    changed();
  }
  const change = (label, fn, ev) => { const before = snap(); fn(); finish(before, label, typeof ev === 'function' ? ev() : ev); };
  function changed() { prune(); render(); engine.sync(); }
  function prune() {
    for (const id of [...sel.tracks]) if (!byId(id)) sel.tracks.delete(id);
    if (!anyById(sel.anchor)) sel.anchor = selIds()[0] ?? null;
    if (!sel.tracks.size && !ret(sel.anchor) && state.tracks.length) { sel.tracks.add(state.tracks[0].id); sel.anchor = state.tracks[0].id; }
    if (!state.tracks.some(t => t.clips.some(c => c.id === sel.clip))) sel.clip = null;
    if (!current()?.devices.some(d => d.id === sel.device)) sel.device = null;
    if (sel.range) { sel.range.tracks = sel.range.tracks.filter(byId); if (!sel.range.tracks.length) sel.range = null; }
  }
  // Core mixer edit (volume, pan, mute, solo, arm, rename, tempo) on a study track: the operations the study scores.
  function edit(op, id, value, source) {
    const i = op === 'tempo' ? -1 : idx(id), before = op === 'tempo' ? state.tempo : coreOf(state.tracks[i]);
    change(op, () => applyAction(state, { op, track: i + 1, value }), () => ['edit', { op, track: i + 1, id, value, source, before }]);
  }
  const retEdit = (id, field, value, source) => change(field, () => (ret(id)[field] = value), ['return', { op: field, ret: id, value, source }]);
  function restore(from, to, word) {
    const u = from.pop();
    if (!u) return status(`Nothing to ${word.toLowerCase()}`);
    to.push({ s: snap(), label: u.label });
    const back = JSON.parse(u.s);
    state = back.s; Object.assign(T, back.t);
    changed(); status(`${word}: ${u.label}`); onEvent(word.toLowerCase(), { label: u.label });
  }

  // ---------- value fields: sliders, faders and knobs you drag or type into ----------
  // o: { fk, label, get, fmt, pos(v)->0..1, center, knob, fader, drag(start, dy, shift), step(shift), bump(v, d), reset, set(v), log(before, after, source), parse, chars }
  function vfield(el, o) {
    if (el.querySelector('input')) return el;
    el.classList.add('vf'); el.tabIndex = 0; el.dataset.fk = o.fk;
    const v = o.get(), p = o.pos(v);
    el.replaceChildren();
    if (o.knob) el.append(knobSvg(p, o.center));
    else if (o.fader) {
      const at = q => `calc(${q * 100}% - ${q * 10}px + 1px)`, zero = h('i', 'zero'), cap = h('i', 'cap');
      zero.style.bottom = at(dbToPos(0)); cap.style.bottom = at(p);
      el.append(h('i', 'rail'), zero, cap);
    } else {
      const f = h('i', 'fill');
      if (o.center) { f.style.left = `${Math.min(p, 0.5) * 100}%`; f.style.width = `${Math.abs(p - 0.5) * 100}%`; } else f.style.width = `${p * 100}%`;
      el.append(f);
    }
    if (!o.fader) el.append(h('span', 'txt', { textContent: o.fmt(v) }));
    el.onpointerdown = e => {
      if (e.button) return;
      e.preventDefault(); e.stopPropagation(); el.focus();
      const before = snap(), y0 = e.clientY, start = o.get();
      let moved = false;
      const mv = ev => { moved = true; o.set(o.drag(start, ev.clientY - y0, ev.shiftKey)); changed(); };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (moved) finish(before, o.label, o.log(start, o.get(), 'drag'));
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    };
    el.ondblclick = e => { e.stopPropagation(); typeIn(el, o, o.fmt(o.get()).replace(/ (dB|BPM|Hz|%|ms|s|: 1)$/, '')); };
    el.onkeydown = e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); commit(o, o.bump(o.get(), o.step(e.shiftKey) * (e.key === 'ArrowUp' ? 1 : -1)), 'key'); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); commit(o, o.reset, 'key'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); typeIn(el, o, ''); }
      else if ((o.chars ?? /^[\d.-]$/).test(e.key) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); typeIn(el, o, e.key); }
    };
    return el;
  }
  function commit(o, v, source) { const before = snap(), start = o.get(); o.set(v); finish(before, o.label, o.log(start, o.get(), source)); }
  function typeIn(el, o, init) {
    const inp = h('input', 'vin', { value: init });
    el.append(inp); inp.focus();
    if (init.length !== 1) inp.select();
    let done = false;
    const end = ok => {
      if (done) return; done = true;
      const v = inp.value.trim(); inp.remove();
      if (ok && v) commit(o, o.parse ? o.parse(v) : v, 'type'); else vfield(el, o);
      $(`[data-fk="${o.fk}"]`)?.focus();
    };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') end(true); if (e.key === 'Escape') end(false); };
    inp.onblur = () => end(true);
    inp.onpointerdown = e => e.stopPropagation();
  }
  const dbOpts = ({ fk, label, get, set, log, reset = 0, fader = false, knob = false, max = VOL_MAX }) => ({
    fk, label, get, set, log, reset, fader, knob, fmt: v => `${fmtVol(v)} dB`, pos: v => dbToPos(Math.min(v, max)),
    drag: (s, dy, sh) => Math.min(max, posToDb(clamp(dbToPos(s) - dy / (fader ? FADER_H - 10 : 300) / (sh ? 10 : 1), 0, 1))),
    step: sh => (sh ? 0.1 : 1), bump: (v, d) => Math.min(max, Math.round(((v <= VOL_MIN ? -60 : v) + d) * 10) / 10),
  });
  const panOpts = ({ fk, label, get, set, log, knob = false }) => ({
    fk, label, get, set, log, knob, center: true, fmt: fmtPan, pos: v => (v + 50) / 100, reset: 0, chars: /^[\d.lrcLRC-]$/,
    drag: (s, dy, sh) => Math.round(s - dy / (sh ? 6 : 1.5)), step: sh => (sh ? 1 : 5), bump: (v, d) => v + d,
  });
  const coreLog = (op, id) => (before, value, source) => ['edit', { op, track: op === 'tempo' ? 0 : idx(id) + 1, id, value, source, before }];
  const putDb = (obj, key, max = VOL_MAX) => v => { const n = parseDb(v); if (Number.isFinite(n)) obj()[key] = clamp(n, VOL_MIN, max); };
  const putPan = obj => v => { const n = parsePan(v); if (Number.isFinite(n)) obj().pan = clamp(Math.round(n), -50, 50); };
  // Volume and pan of a study track or a return track; `tag` keeps the header, strip and fader fields apart.
  function volOpts(t, tag, extra = {}) {
    if (ret(t.id)) return dbOpts({ fk: `vol-${t.id}-${tag}`, label: 'Return Volume', get: () => ret(t.id).vol, set: putDb(() => ret(t.id), 'vol'), log: (b, v, s) => ['return', { op: 'volume', ret: t.id, value: v, before: b, source: s }], ...extra });
    return dbOpts({ fk: `vol-${t.id}-${tag}`, label: 'Volume', get: () => byId(t.id).vol, set: v => applyAction(state, { op: 'volume', track: idx(t.id) + 1, value: v }), log: coreLog('volume', t.id), ...extra });
  }
  function panOptsFor(t, tag, extra = {}) {
    if (ret(t.id)) return panOpts({ fk: `pan-${t.id}-${tag}`, label: 'Return Pan', get: () => ret(t.id).pan, set: putPan(() => ret(t.id)), log: (b, v, s) => ['return', { op: 'pan', ret: t.id, value: v, before: b, source: s }], ...extra });
    return panOpts({ fk: `pan-${t.id}-${tag}`, label: 'Pan', get: () => byId(t.id).pan, set: v => applyAction(state, { op: 'pan', track: idx(t.id) + 1, value: v }), log: coreLog('pan', t.id), ...extra });
  }
  const sendOpts = (t, r) => dbOpts({
    fk: `send-${t.id}-${r.id}`, label: `Send ${r.id}`, get: () => byId(t.id).sends[r.id], set: putDb(() => byId(t.id).sends, r.id, 0), knob: true, max: 0, reset: VOL_MIN,
    log: (b, v, s) => ['send', { track: idx(t.id) + 1, send: r.id, value: v, before: b, source: s }],
  });
  const mainOpts = tag => dbOpts({ fk: `vol-main-${tag}`, label: 'Main Volume', get: () => state.main.vol, set: putDb(() => state.main, 'vol'), log: (b, v, s) => ['main', { op: 'volume', value: v, before: b, source: s }], fader: tag === 'fader' });
  const tempoField = {
    fk: 'tempo', label: 'Tempo', get: () => state.tempo, fmt: v => v.toFixed(2), pos: () => 0,
    drag: (s, dy, sh) => Math.round((s - dy * (sh ? 0.01 : 0.5)) * 100) / 100, step: sh => (sh ? 0.01 : 1), bump: (v, d) => Math.round((v + d) * 100) / 100, reset: 120,
    set: v => applyAction(state, { op: 'tempo', track: 0, value: v }), log: coreLog('tempo'),
  };
  function paramOpts(owner, d, p) {
    const norm = v => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
    const denorm = x => (p.log ? p.min * (p.max / p.min) ** x : p.min + x * (p.max - p.min));
    const dec = { Hz: 0, dB: 1, '%': 0, ms: 0, s: 2, ':1': 1, '': 0 }[p.unit];
    const round = v => Math.round(clamp(v, p.min, p.max) * 10 ** dec) / 10 ** dec;
    const dev = () => anyById(owner.id)?.devices.find(x => x.id === d.id);
    return {
      fk: `p-${d.id}-${p.label}`, label: `${d.type} ${p.label}`, knob: true, center: p.unit === '', get: () => dev().params[p.label], fmt: v => fmtParam(p, v), pos: norm,
      drag: (s, dy, sh) => round(denorm(clamp(norm(s) - dy / (sh ? 1000 : 150), 0, 1))), step: sh => (sh ? 0.01 : 0.05),
      bump: (v, x) => round(denorm(clamp(norm(v) + x, 0, 1))), reset: p.def, chars: /^[\d.lrcLRC-]$/,
      parse: s => { const k = /k/i.test(s) ? 1000 : 1, n = p.unit === '' ? (/^c$/i.test(s) ? 0 : parseFloat(s) * (/l/i.test(s) ? -1 : 1)) : parseFloat(s) * k; return Number.isFinite(n) ? n : p.def; },
      set: v => { if (Number.isFinite(+v)) dev().params[p.label] = round(+v); },
      log: (before, value, source) => ['device', { action: 'param', track: where(owner.id), device: d.type, param: p.label, value, before, source }],
    };
  }

  // ---------- selection ----------
  function select(id, e = {}) {
    const ids = state.tracks.map(t => t.id);
    if (e.shiftKey && byId(sel.anchor)) {
      const a = ids.indexOf(sel.anchor), b = ids.indexOf(id);
      sel.tracks = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if ((e.metaKey || e.ctrlKey) && byId(sel.anchor)) {
      sel.tracks.has(id) && sel.tracks.size > 1 ? sel.tracks.delete(id) : sel.tracks.add(id);
      sel.anchor = id;
    } else { sel.tracks = new Set([id]); sel.anchor = id; }
    sel.clip = null; sel.range = null;
    if (!current()?.devices.some(d => d.id === sel.device)) sel.device = null;
    onEvent('select', { tracks: selIds().map(x => idx(x) + 1), mod: e.shiftKey ? 'shift' : e.metaKey || e.ctrlKey ? 'cmd' : '' });
    render();
  }
  function selectReturn(id) {
    sel = { tracks: new Set(), anchor: id, clip: null, device: null };
    onEvent('select', { ret: id });
    render();
  }
  const isDouble = id => { const now = performance.now(), d = lastDown.id === id && now - lastDown.at < 400; lastDown = { id, at: now }; return d; };

  // ---------- tracks ----------
  function insertAudioTrack(source, { name, device, sample, start } = {}) {
    const at = insertAt(), t = newTrack(name ?? `${at + 1} Audio`, nextColor());
    if (device) t.devices.push(newDevice(device));
    if (sample) t.clips.push({ id: uid('c'), name: sample, start, len: 4, offset: 0, sound: SAMPLES[sample], on: true });
    change(sample ? `Insert ${sample}` : 'Insert Audio Track', () => { state.tracks.splice(at, 0, t); sel.tracks = new Set([t.id]); sel.anchor = t.id; sel.device = t.devices[0]?.id ?? null; },
      ['track', { action: 'insert', track: at + 1, id: t.id, device, sample, source }]);
  }
  function deleteTracks(ids, source) {
    if (!ids.length) return;
    if (ids.length >= state.tracks.length) return status('A Live Set needs at least one track.');
    const gone = ids.map(id => ({ track: idx(id) + 1, id, name: byId(id).name }));
    change('Delete Track', () => { state.tracks = state.tracks.filter(t => !ids.includes(t.id)); }, ['track', { action: 'delete', tracks: gone, source }]);
  }
  function duplicateTracks(ids, source) {
    const copies = [];
    change('Duplicate Track', () => {
      for (const id of [...ids].reverse()) {
        const t = clone(byId(id)), at = idx(id) + 1;
        t.id = uid('t'); t.clips.forEach(c => (c.id = uid('c'))); t.devices.forEach(d => (d.id = uid('d')));
        state.tracks.splice(at, 0, t); copies.push(t.id);
      }
      sel.tracks = new Set(copies); sel.anchor = copies.at(-1);
    }, () => ['track', { action: 'duplicate', tracks: ids.map(id => idx(id) + 1), source }]);
  }
  function inlineRename(el, value, done) {
    const inp = h('input', 'rin', { value });
    el.replaceChildren(inp); inp.focus(); inp.select();
    let over = false;
    const end = ok => { if (over) return; over = true; const v = inp.value.trim(); ok && v && v !== value ? done(v) : render(); };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') end(true); if (e.key === 'Escape') end(false); };
    inp.onblur = () => end(true);
    inp.onpointerdown = e => e.stopPropagation();
  }
  function renameTrack(id, attr = 'tn') { // tn: the arrangement header name, sn: the Mixer strip title
    const el = $(`[data-${attr}="${id}"]`);
    if (!el) return;
    if (ret(id)) inlineRename(el, ret(id).name, v => retEdit(id, 'name', v, 'type'));
    else inlineRename(el, byId(id).name, v => edit('rename', id, v, 'type'));
  }
  const setColor = (id, c) => change('Track Color', () => (anyById(id).color = c), ['track', { action: 'color', track: where(id), value: c }]);

  // ---------- clips ----------
  // offset: where in its audio (in bars) a clip starts playing, so moving a clip moves its audio and trimming its start doesn't.
  const offsetOf = c => c.offset ?? c.start;
  const clipOf = id => { for (const t of state.tracks) { const c = t.clips.find(x => x.id === id); if (c) return [t, c]; } return []; };
  // Removes everything on track t between s and e; clips crossing the edges are trimmed and keep their audio in place.
  function cutOut(t, s, e) {
    t.clips = t.clips.flatMap(c => {
      if (c.start + c.len <= s + 1e-9 || c.start >= e - 1e-9) return [c];
      const out = [];
      if (c.start < s) out.push({ ...c, len: tidy(s - c.start) });
      if (c.start + c.len > e) out.push({ ...c, id: c.start < s ? uid('c') : c.id, start: e, len: tidy(c.start + c.len - e), offset: tidy(offsetOf(c) + e - c.start) });
      return out;
    });
  }
  function carve(t, keep) { // overwrite: clips under `keep` are cut, like Live
    t.clips = t.clips.filter(c => c !== keep);
    cutOut(t, keep.start, keep.start + keep.len);
    t.clips.push(keep);
  }
  function splitAt(t, at, only) {
    t.clips = t.clips.flatMap(c => (only && c.id !== only) || c.start >= at - 1e-6 || c.start + c.len <= at + 1e-6 ? [c]
      : [{ ...c, len: tidy(at - c.start) }, { ...c, id: uid('c'), start: at, len: tidy(c.start + c.len - at), offset: tidy(offsetOf(c) + at - c.start) }]);
  }
  // The pieces of t's clips inside [s, e), positioned relative to s.
  const extract = (t, s, e) => t.clips.filter(c => c.start < e - 1e-9 && c.start + c.len > s + 1e-9).map(c => {
    const a = Math.max(s, c.start), b = Math.min(e, c.start + c.len);
    return { ...c, id: null, start: tidy(a - s), len: tidy(b - a), offset: tidy(offsetOf(c) + a - c.start) };
  });
  function placeClips(t, list, at) { for (const x of list) carve(t, { ...x, id: uid('c'), start: tidy(at + x.start) }); }
  // Moves every clip at or after `at` on every track by d bars (splitting clips that cross `at`).
  function shiftAll(at, d) { for (const t of state.tracks) { splitAt(t, at); for (const c of t.clips) if (c.start >= at - 1e-9) c.start = tidy(c.start + d); } }
  // What the editing commands act on: the time selection, or the selected clip's span on its track.
  function editRange() {
    if (sel.range) return sel.range;
    const [t, c] = clipOf(sel.clip);
    return c ? { start: c.start, end: c.start + c.len, tracks: [t.id] } : null;
  }
  const rangeLog = R => ({ start: R.start, end: R.end, tracks: R.tracks.map(id => idx(id) + 1) });
  const clipLog = (action, t, c, extra = {}) => ['clip', { action, track: idx(t.id) + 1, name: c.name, start: c.start, ...extra }];
  function addClip(id, c, label, ev) {
    change(label, () => { const t = byId(id); carve(t, c); sel.clip = c.id; sel.range = null; sel.tracks = new Set([id]); sel.anchor = id; }, ev);
  }
  function toggleClip(id, source) {
    const [t, c] = clipOf(id);
    if (c) change('Clip Activator', () => (clipOf(id)[1].on = c.on === false), clipLog(c.on === false ? 'activate' : 'deactivate', t, c, { source }));
  }
  function splitClips(source) {
    const only = sel.range ? null : sel.clip, pts = sel.range ? [sel.range.start, sel.range.end] : [T.marker];
    const ids = sel.range ? sel.range.tracks : only ? [clipOf(only)[0].id] : selIds();
    const hits = ids.filter(id => byId(id).clips.some(c => (!only || c.id === only) && pts.some(p => c.start < p - 1e-6 && c.start + c.len > p + 1e-6)));
    if (!hits.length) return status('To split, click inside a clip to place the insert marker there (or drag to select time), then press Cmd+E.');
    change('Split', () => { for (const id of hits) for (const p of pts) splitAt(byId(id), p, only); },
      ['clip', { action: 'split', at: pts, tracks: hits.map(id => idx(id) + 1), source }]);
  }
  function copySel(cut, source) {
    const R = editRange();
    if (!R) return status('Click a clip, or drag across a track to select time, then copy or cut it.');
    clipboard = { len: R.end - R.start, tracks: R.tracks.map(id => extract(byId(id), R.start, R.end)) };
    onEvent('clip', { action: cut ? 'cut' : 'copy', ...rangeLog(R), source });
    if (cut) change('Cut', () => { R.tracks.forEach(id => cutOut(byId(id), R.start, R.end)); sel.clip = null; });
    else status(`Copied ${fmtPos(clipboard.len, true)} from ${R.tracks.length} track${R.tracks.length > 1 ? 's' : ''}`);
  }
  function pasteSel(source) {
    const base = idx(current()?.id);
    if (!clipboard) return status('Nothing to paste. Copy (Cmd+C) or cut (Cmd+X) a clip or a time selection first.');
    if (base < 0) return status('Select a track to paste into.');
    const at = T.marker, ids = clipboard.tracks.map((_, i) => state.tracks[base + i]?.id).filter(Boolean);
    change('Paste', () => {
      ids.forEach((id, i) => placeClips(byId(id), clipboard.tracks[i], at));
      sel.range = { start: at, end: tidy(at + clipboard.len), tracks: ids }; sel.clip = null; sel.tracks = new Set(ids);
    }, ['clip', { action: 'paste', at, tracks: ids.map(id => idx(id) + 1), source }]);
  }
  function deleteRange(R, source) {
    change('Delete', () => { R.tracks.forEach(id => cutOut(byId(id), R.start, R.end)); sel.clip = null; }, ['clip', { action: 'delete', ...rangeLog(R), source }]);
  }
  function duplicateRange(R, source) {
    const len = R.end - R.start, parts = R.tracks.map(id => extract(byId(id), R.start, R.end));
    change('Duplicate', () => {
      R.tracks.forEach((id, i) => placeClips(byId(id), parts[i], R.end));
      sel.range = { start: R.end, end: tidy(R.end + len), tracks: R.tracks }; sel.clip = null;
    }, ['clip', { action: 'duplicate', ...rangeLog(R), source }]);
  }
  // Live's time commands act on every track: they insert or remove time, moving everything after it.
  function timeOp(kind, source) {
    const R = editRange(), ev = extra => ['time', { action: kind, ...extra, source }];
    if (kind === 'paste time') {
      if (!clipboard) return status('Nothing to paste. Use Cut Time (Cmd+Shift+X) or copy something first.');
      const at = T.marker, base = clipboard.ids ? 0 : Math.max(0, idx(current()?.id));
      return change('Paste Time', () => {
        shiftAll(at, clipboard.len);
        clipboard.tracks.forEach((list, i) => { const t = clipboard.ids ? byId(clipboard.ids[i]) : state.tracks[base + i]; if (t) placeClips(t, list, at); });
        sel.range = { start: at, end: tidy(at + clipboard.len), tracks: allIds() }; sel.clip = null;
      }, ev({ at, len: clipboard.len }));
    }
    if (!R) return status('Select some time first: drag across a track, or click a clip or the loop brace.');
    const len = R.end - R.start;
    if (kind === 'insert silence') return change('Insert Silence', () => shiftAll(R.start, len), ev(rangeLog(R)));
    if (kind === 'duplicate time') {
      const parts = state.tracks.map(t => extract(t, R.start, R.end));
      return change('Duplicate Time', () => {
        shiftAll(R.end, len); state.tracks.forEach((t, i) => placeClips(t, parts[i], R.end));
        sel.range = { start: R.end, end: tidy(R.end + len), tracks: R.tracks }; sel.clip = null;
      }, ev(rangeLog(R)));
    }
    if (kind === 'cut time') clipboard = { len, tracks: state.tracks.map(t => extract(t, R.start, R.end)), ids: allIds() };
    change(kind === 'cut time' ? 'Cut Time' : 'Delete Time', () => {
      for (const t of state.tracks) { cutOut(t, R.start, R.end); for (const c of t.clips) if (c.start >= R.end - 1e-9) c.start = tidy(c.start - len); }
      sel.range = null; sel.clip = null; T.marker = T.stopPos = R.start;
    }, ev(rangeLog(R)));
  }
  const renameClip = id => {
    const el = $(`[data-cn="${id}"]`), [t, c] = clipOf(id);
    if (el) inlineRename(el, c.name, v => change('Rename Clip', () => (clipOf(id)[1].name = v), clipLog('rename', t, c, { value: v, source: 'type' })));
  };
  function placeSample(name, trackId, bar, source) {
    const start = Math.max(0, snapX(bar));
    if (!trackId) return insertAudioTrack(source, { name, sample: name, start });
    const t = byId(trackId), c = { id: uid('c'), name, start, len: 4, offset: 0, sound: SAMPLES[name], on: true };
    addClip(trackId, c, `Add ${name}`, clipLog('add', t, c, { sample: name, source }));
  }

  // ---------- devices ----------
  function addDevice(id, type, source) {
    const d = newDevice(type), owner = anyById(id);
    change(`Add ${type}`, () => {
      anyById(id).devices.push(d);
      if (ret(id)) sel = { tracks: new Set(), anchor: id, clip: null, device: d.id };
      else { sel.tracks = new Set([id]); sel.anchor = id; sel.device = d.id; }
    }, ['device', { action: 'add', track: where(id), device: type, source }]);
    status(`${type} added to ${owner.name}`);
  }
  function deleteDevice(did, source) {
    const owner = [...state.tracks, ...state.returns].find(x => x.devices.some(d => d.id === did)), d = owner?.devices.find(x => x.id === did);
    if (d) change(`Delete ${d.type}`, () => { owner.devices = owner.devices.filter(x => x.id !== did); }, ['device', { action: 'delete', track: where(owner.id), device: d.type, source }]);
  }
  function toggleDevice(owner, d, source) {
    change(`${d.type} On/Off`, () => { const x = anyById(owner.id).devices.find(y => y.id === d.id); x.on = !x.on; },
      ['device', { action: d.on ? 'off' : 'on', track: where(owner.id), device: d.type, source }]);
  }
  function dropOn(id, e, source) { // a browser item dropped on a track/return row (id) or the drop area (null)
    const it = drag;
    drag = null;
    if (!it) return;
    if (it.kind === 'device') return id ? addDevice(id, it.name, source) : insertAudioTrack(source, { device: it.name });
    if (ret(id)) return status('Samples go on audio tracks, not return tracks.');
    placeSample(it.name, id, (e.clientX - inner.getBoundingClientRect().left) / view.ppb, source);
  }
  const acceptDrop = (el, id) => {
    el.ondragover = e => { if (drag) { e.preventDefault(); el.classList.add('dragover'); } };
    el.ondragleave = () => el.classList.remove('dragover');
    el.ondrop = e => { e.preventDefault(); el.classList.remove('dragover'); dropOn(id, e, 'drag'); };
  };

  // ---------- selection-wide commands ----------
  function deleteSel(source) {
    const R = editRange();
    if (sel.device) deleteDevice(sel.device, source);
    else if (R) deleteRange(R, source);
    else deleteTracks(selIds(), source);
  }
  const duplicateSel = source => { const R = editRange(); R ? duplicateRange(R, source) : duplicateTracks(selIds(), source); };
  const renameSel = () => (sel.clip ? renameClip(sel.clip) : renameTrack(sel.anchor ?? selIds()[0]));
  function toggleSel(op) {
    const ids = selIds();
    if (!ids.length) return;
    const first = byId(ids[0]), v = op === 'mute' ? first.on : !first[op];
    change(op, () => ids.forEach(id => applyAction(state, { op, track: idx(id) + 1, value: v })),
      () => ['edit', { op, tracks: ids.map(id => idx(id) + 1), value: v, source: 'shortcut' }]);
  }

  // ---------- transport ----------
  function play(resume = false) {
    const from = resume ? T.stopPos : T.marker;
    engine.play(from);
    onEvent('transport', { action: resume ? 'continue' : 'play', pos: from });
    renderCtrl();
  }
  function stop() {
    if (engine.playing) {
      T.stopPos = engine.position();
      if (T.rec) endRecord();
      engine.stop();
      onEvent('transport', { action: 'stop', pos: T.stopPos });
    } else {
      T.marker = T.stopPos = 0;
      onEvent('transport', { action: 'return to start' });
    }
    render();
  }
  function startRecord() {
    const playing = engine.playing, start = playing ? engine.position() : T.marker;
    T.rec = { before: snap(), start, clips: new Map(), drawn: 0 };
    for (const t of state.tracks) if (t.arm) {
      const c = { id: uid('c'), name: `${t.name} Rec`, start, len: 0, rec: true, sound: null, on: true };
      t.clips.push(c); T.rec.clips.set(t.id, c.id);
    }
    if (!T.rec.clips.size) status('No track is armed. Arm a track (its Arm button, or C) to record onto it.');
    onEvent('transport', { action: 'record on', pos: start, tracks: [...T.rec.clips.keys()].map(id => idx(id) + 1) });
    if (!playing) play(); else render();
  }
  function endRecord() {
    const R = T.rec;
    T.rec = null;
    for (const [tid, cid] of R.clips) {
      const t = byId(tid), c = t?.clips.find(x => x.id === cid);
      if (!c) continue;
      if (c.len < 1 / 16) { t.clips = t.clips.filter(x => x !== c); continue; }
      c.len = Math.round(c.len * 16) / 16; carve(t, c);
    }
    finish(R.before, 'Record', ['transport', { action: 'record off', from: R.start, tracks: [...R.clips.keys()].map(id => idx(id) + 1) }]);
  }
  const toggleRecord = () => (T.rec ? endRecord() : startRecord());
  function toggleLoop(fromSelection) {
    const R = fromSelection && editRange();
    if (R) Object.assign(T, { loop: true, loopStart: R.start, loopEnd: R.end }); else T.loop = !T.loop;
    onEvent('transport', { action: 'loop', on: T.loop, start: T.loopStart, end: T.loopEnd });
    render();
  }
  const setMarker = (bars, free) => { T.marker = T.stopPos = Math.max(0, snapX(bars, free)); };

  // The session as the assistant sees it: the session, the transport settings and what is on screen.
  function session() {
    const p = engine.playing ? engine.position() : null, R = sel.range;
    return {
      ...clone(state), metronome: T.metro, transport: T.rec ? 'recording' : engine.playing ? 'playing' : 'stopped', marker: T.marker,
      loop: { on: T.loop, start: T.loopStart, end: T.loopEnd },
      view: { selected: selIds().map(id => byId(id).name), range: R && { start: R.start, end: R.end, tracks: R.tracks.map(id => byId(id)?.name).filter(Boolean) }, playhead: p },
    };
  }

  // ---------- views ----------
  function toggleView(k) {
    view[k] = !view[k];
    onEvent('view', { [k]: view[k] });
    render();
  }
  function layout() {
    const { browser: b, info: i, detail: d } = view;
    work.style.gridTemplateColumns = `${b || i ? 210 : 0}px minmax(0, 1fr) 280px`;
    work.style.gridTemplateRows = `minmax(0, 1fr) ${i || d ? 170 : 0}px`;
    work.style.gridTemplateAreas = `"${b ? 'browser' : 'arr'} arr asst" "${i ? 'info' : b ? 'browser' : 'detail'} detail asst"`;
    $('#browser').hidden = !b; $('#info').hidden = !i; $('#detail').style.visibility = d ? '' : 'hidden'; $('#detail').hidden = !i && !d;
    $('#mixer').hidden = !view.mixer;
    $('#browserBtn').classList.toggle('on', b); $('#infoBtn').classList.toggle('on', i); $('#detailBtn').classList.toggle('on', d); $('#mixerBtn').classList.toggle('on', view.mixer);
  }
  function zoom(f) {
    const center = (scroller.scrollLeft + (scroller.clientWidth - HDR) / 2) / view.ppb;
    view.ppb = clamp(view.ppb * f, 8, 240);
    render();
    scroller.scrollLeft = center * view.ppb - (scroller.clientWidth - HDR) / 2;
  }

  // ---------- context menu ----------
  const menuEl = $('#menu');
  function menu(e, items) { // items: [label, shortcut, fn] | null (separator) | Element
    e.preventDefault(); e.stopPropagation();
    menuEl.replaceChildren(...items.map(it => {
      if (it === null) return h('div', 'msep');
      if (it instanceof Element) return it;
      const [label, key, fn] = it, el = h('div', fn ? 'mi' : 'mi dis');
      el.append(h('span', '', { textContent: label }), h('span', 'mk', { textContent: key ?? '' }));
      if (fn) el.onclick = () => { menuEl.hidden = true; fn(); };
      return el;
    }));
    menuEl.hidden = false;
    menuEl.style.left = `${Math.min(e.clientX, innerWidth - menuEl.offsetWidth - 4)}px`;
    menuEl.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - menuEl.offsetHeight - 4))}px`;
  }
  addEventListener('pointerdown', e => { if (!menuEl.contains(e.target)) menuEl.hidden = true; }, true);
  function palette(id) {
    const g = info(h('div', 'pal'), 'Track Color', 'Click a color to change the color of the track and its clips.');
    for (const c of PALETTE) {
      const s = h('div', `sw${anyById(id).color === c ? ' on' : ''}`);
      s.style.background = c;
      s.onclick = () => { menuEl.hidden = true; setColor(id, c); };
      g.append(s);
    }
    return g;
  }
  function trackMenu(e, t) {
    if (!sel.tracks.has(t.id)) select(t.id);
    menu(e, [
      ['Rename', 'Cmd+R', () => renameTrack(t.id)], ['Duplicate', 'Cmd+D', () => duplicateTracks(selIds(), 'menu')],
      ['Delete', 'Delete', () => deleteTracks(selIds(), 'menu')], null,
      ['Insert Audio Track', 'Ctrl+T', () => insertAudioTrack('menu')], ['Paste', 'Cmd+V', clipboard && (() => pasteSel('menu'))], null,
      palette(t.id),
    ]);
  }
  // Editing commands, as in Live's Edit menu; they act on the time selection or the selected clip.
  function editItems(e) {
    const R = editRange(), on = fn => R && fn;
    return [
      ['Cut', 'Cmd+X', on(() => copySel(true, 'menu'))], ['Copy', 'Cmd+C', on(() => copySel(false, 'menu'))], ['Paste', 'Cmd+V', clipboard && (() => pasteSel('menu'))],
      ['Duplicate', 'Cmd+D', on(() => duplicateRange(R, 'menu'))], ['Delete', 'Delete', on(() => deleteRange(R, 'menu'))], null,
      ['Split', 'Cmd+E', () => splitClips('menu')], ['Loop Selection', 'Cmd+L', on(() => toggleLoop(true))], null,
      ['Insert Silence', 'Cmd+I', on(() => timeOp('insert silence', 'menu'))], ['Cut Time', 'Cmd+Shift+X', on(() => timeOp('cut time', 'menu'))],
      ['Paste Time', 'Cmd+Shift+V', clipboard && (() => timeOp('paste time', 'menu'))], ['Duplicate Time', 'Cmd+Shift+D', on(() => timeOp('duplicate time', 'menu'))],
      ['Delete Time', 'Cmd+Shift+Delete', on(() => timeOp('delete time', 'menu'))], null,
      [`Grid: ${gridLabel()} …`, 'Cmd+1/2/3/4', () => gridMenu(e)],
    ];
  }
  function laneMenu(e, t) {
    if (!sel.range?.tracks.includes(t.id) && !sel.tracks.has(t.id)) select(t.id);
    menu(e, [...editItems(e), null, ['Insert Audio Track', 'Ctrl+T', () => insertAudioTrack('menu')]]);
  }
  function gridMenu(e) {
    const G = view.grid, chk = b => (b ? '✓  ' : '    ');
    menu(e, [
      ...ADAPTIVE.map(([n], i) => [`${chk(G.mode === 'adaptive' && G.level === i)}Adaptive Grid: ${n}`, '', () => setGrid(g => { g.mode = 'adaptive'; g.level = i; })]), null,
      ...GRIDS.map((x, i) => [`${chk(G.mode === 'fixed' && G.fixed === i)}Fixed Grid: ${gridName(x)}`, '', () => setGrid(g => { g.mode = 'fixed'; g.fixed = i; })]), null,
      ['Narrow Grid', 'Cmd+1', () => setGrid(narrowGrid)], ['Widen Grid', 'Cmd+2', () => setGrid(widenGrid)],
      [`${chk(G.triplet)}Triplet Grid`, 'Cmd+3', () => setGrid(g => (g.triplet = !g.triplet))], [`${chk(G.snap)}Snap to Grid`, 'Cmd+4', () => setGrid(g => (g.snap = !g.snap))],
    ]);
  }
  const returnMenu = (e, r) => { selectReturn(r.id); menu(e, [['Rename', 'Cmd+R', () => renameTrack(r.id)], null, palette(r.id)]); };

  // ---------- render ----------
  function render() {
    const keep = document.activeElement?.dataset?.fk;
    meters = new Map();
    renderArrangement(); renderMixer(); renderDevices(); renderBrowser(); renderCtrl(); layout();
    $('#selName').textContent = current()?.name ?? '';
    if (keep) $(`[data-fk="${keep}"]`)?.focus({ preventScroll: true });
  }

  function renderArrangement() {
    const ppb = view.ppb;
    const end = Math.max(BARS_MIN, T.marker + 8, T.loopEnd + 4, ...state.tracks.flatMap(t => t.clips.map(c => c.start + c.len + 8)));
    const bars = Math.max(Math.ceil(end), Math.ceil((scroller.clientWidth - HDR) / ppb)), W = bars * ppb; // always fill the view, so headers stay at the right edge
    inner.style.width = `${W + HDR}px`; inner.style.setProperty('--ppb', `${ppb}px`); inner.style.setProperty('--gpx', `${gridSize() * ppb}px`);
    inner.replaceChildren();
    for (const [id, els] of meters) meters.set(id, els.filter(el => el.isConnected)); // keep only the Mixer's meters

    // ruler: scrub area with bar numbers, and the loop brace
    const ruler = h('div', 'trow ruler'), rl = h('div', 'lane rlane');
    rl.style.width = `${W}px`;
    const scrub = info(h('div', 'scrub'), 'Scrub Area', 'Click here to jump playback to that bar and beat. When stopped, it sets where playback starts.');
    const every = ppb >= 22 ? 1 : ppb >= 11 ? 2 : 4;
    for (let b = 0; b < bars; b += every) scrub.append(h('span', 'bar', { textContent: b + 1, style: `left:${b * ppb}px` }));
    if (sel.range) scrub.append(h('div', 'rsel', { style: `left:${sel.range.start * ppb}px;width:${(sel.range.end - sel.range.start) * ppb}px` }));
    scrub.onpointerdown = e => {
      setMarker((e.clientX - scrub.getBoundingClientRect().left) / ppb, e.metaKey || e.altKey);
      if (engine.playing) engine.play(T.marker);
      onEvent('transport', { action: 'jump', pos: T.marker });
      render();
    };
    const strip = h('div', 'loopStrip'), brace = h('div', `brace${T.loop ? ' on' : ''}`);
    info(brace, 'Loop Brace', 'Marks the region that repeats when the Loop Switch is on. Drag it to move the loop; drag its left or right edge to change where it starts or ends (snaps to the grid; hold Cmd to move freely). Click it to select its time. [Cmd+L] loops the selected time or clip.');
    brace.style.left = `${T.loopStart * ppb}px`; brace.style.width = `${(T.loopEnd - T.loopStart) * ppb}px`;
    brace.onpointerdown = e => {
      e.preventDefault();
      const r = brace.getBoundingClientRect(), mode = e.clientX > r.right - 7 ? 'end' : e.clientX < r.left + 7 ? 'start' : 'move', x0 = e.clientX, s0 = T.loopStart, e0 = T.loopEnd;
      let moved = false;
      const mv = ev => {
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        moved = true;
        const dx = (ev.clientX - x0) / ppb, free = ev.metaKey || ev.altKey, min = gridSize();
        if (mode === 'end') T.loopEnd = Math.max(tidy(s0 + min), snapX(e0 + dx, free));
        else if (mode === 'start') T.loopStart = clamp(snapX(s0 + dx, free), 0, tidy(e0 - min));
        else { T.loopStart = Math.max(0, snapX(s0 + dx, free)); T.loopEnd = tidy(T.loopStart + e0 - s0); }
        renderArrangement(); renderCtrl();
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (moved) return onEvent('transport', { action: 'loop region', start: T.loopStart, end: T.loopEnd });
        sel.range = { start: T.loopStart, end: T.loopEnd, tracks: allIds() }; sel.clip = null; sel.tracks = new Set(allIds());
        render();
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    };
    strip.append(brace); rl.append(scrub, strip);
    ruler.append(rl, h('div', 'hdr corner'));
    inner.append(ruler);

    state.tracks.forEach((t, i) => inner.append(trackRow(t, i, W)));
    const drop = h('div', 'trow droprow'), dl = info(h('div', 'lane dlane', { textContent: 'Drop Files and Devices Here' }), 'Drop Area',
      'Drop a sample here to create a new audio track with it, or an audio effect to create a new audio track with that effect.');
    dl.style.width = `${W}px`;
    acceptDrop(drop, null);
    drop.append(dl, h('div', 'hdr corner'));
    inner.append(drop);
    for (const r of state.returns) inner.append(returnRow(r, W));
    inner.append(mainRow(W));
    playhead = h('div', 'playhead'); markerEl = h('div', 'marker');
    inner.append(playhead, markerEl);
    frame();
  }

  function trackButtons(t, i) {
    const act = info(h('button', `btn act${t.on ? ' on' : ''}`, { textContent: i + 1 }), 'Track Activator',
      `Turns the track on or off. A track that is off makes no sound (it is muted).${i < 8 ? ` [F${i + 1}]` : ''} [0] toggles the selected tracks.`);
    act.onclick = () => edit('mute', t.id, t.on, 'click');
    const solo = info(h('button', `btn solo${t.solo ? ' on' : ''}`, { textContent: 'S' }), 'Solo',
      'Listen to this track alone: every track that is not soloed is silenced (return tracks keep playing). Click again to unsolo. Several tracks can be soloed at once. [S] toggles the selected tracks.');
    solo.onclick = () => edit('solo', t.id, !t.solo, 'click');
    const arm = info(h('button', `btn arm${t.arm ? ' on' : ''}`), 'Arm Recording',
      'Arms the track for recording. The Arrangement Record button then records a new clip on every armed track. [C] toggles the selected tracks.');
    arm.onclick = () => edit('arm', t.id, !t.arm, 'click');
    return [act, solo, arm];
  }
  function returnButtons(r) {
    const act = info(h('button', `btn act${r.on ? ' on' : ''}`, { textContent: r.id }), 'Return Track Activator', 'Turns the return track on or off. When off, its effect is not heard.');
    act.onclick = () => retEdit(r.id, 'on', !r.on, 'click');
    const solo = info(h('button', `btn solo${r.solo ? ' on' : ''}`, { textContent: 'S' }), 'Return Solo', 'Solos this return track: other return tracks are silenced.');
    solo.onclick = () => retEdit(r.id, 'solo', !r.solo, 'click');
    return [act, solo];
  }
  const VOL_INFO = 'Adjusts the output level in dB. Drag up/down (Shift = fine), or click and type a value and press Enter. Up/Down arrows change it by 1 dB (Shift = 0.1 dB). Delete resets it to 0 dB.';
  const PAN_INFO = 'Places the sound in the stereo field, from 50L (left) through C (center) to 50R (right). Drag up/down, or click and type e.g. 30L, 25R or C and press Enter. Delete resets it to center.';
  const meterEl = (id, title) => { const m = info(h('div', 'meter'), title, 'Shows the output level during playback.'), b = h('i'); m.append(b); addMeter(id, b); return m; };
  const nameEl = (t, title, text, onDown) => {
    const n = info(h('div', 'tname', { textContent: t.name }), title, text);
    n.dataset.tn = t.id;
    n.onpointerdown = e => { if (isDouble(t.id)) setTimeout(() => renameTrack(t.id)); else onDown?.(e); };
    return n;
  };

  function trackRow(t, i, W) {
    const row = h('div', `trow track${sel.tracks.has(t.id) ? ' selected' : ''}${t.on ? '' : ' off'}`);
    row.style.setProperty('--c', t.color);
    const lane = info(h('div', 'lane'), 'Arrangement Track', 'Shows this track\'s clips over time. Click to place the insert marker (where playback starts and Cmd+V pastes). Drag left/right to select time; drag up/down too to select it on several tracks. Then cut, copy, paste, duplicate, delete, split or loop it (right-click for the full list). Positions snap to the grid; hold Cmd to move freely.');
    lane.style.width = `${W}px`;
    lane.onpointerdown = e => {
      if (e.button) return;
      // measured against #arrInner, which survives re-renders (this lane element is replaced while dragging)
      const x0 = e.clientX, at = cx => (cx - inner.getBoundingClientRect().left) / view.ppb, a = at(x0), i0 = idx(t.id);
      let moved = false;
      const rowAt = y => {
        const rows = [...inner.querySelectorAll('.trow.track')], i = rows.findIndex(r => { const b = r.getBoundingClientRect(); return y >= b.top && y < b.bottom; });
        return i >= 0 ? i : y < rows[0].getBoundingClientRect().top ? 0 : rows.length - 1;
      };
      const mv = ev => {
        if (!moved && Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        const free = ev.metaKey || ev.altKey, p = snapX(a, free), q = snapX(at(ev.clientX), free), i1 = rowAt(ev.clientY);
        const ids = state.tracks.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).map(x => x.id);
        sel.range = { start: Math.max(0, Math.min(p, q)), end: Math.max(p, q), tracks: ids };
        sel.tracks = new Set(ids); sel.anchor = t.id; sel.clip = null; sel.device = null;
        T.marker = T.stopPos = sel.range.start;
        renderArrangement();
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (!moved) { setMarker(a, e.metaKey || e.altKey); return select(t.id, e); }
        if (sel.range.end - sel.range.start < 1e-6) sel.range = null;
        onEvent('select', { range: sel.range && rangeLog(sel.range) });
        render();
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    };
    for (const c of t.clips) lane.append(clipEl(t, c));
    if (sel.range?.tracks.includes(t.id)) lane.append(h('div', 'tsel', { style: `left:${sel.range.start * view.ppb}px;width:${(sel.range.end - sel.range.start) * view.ppb}px` }));
    const hd = h('div', 'hdr');
    hd.append(h('div', 'strip'),
      nameEl(t, 'Track Title Bar', 'Click to select the track. Shift-click selects a range, Cmd-click adds or removes tracks. Double-click or Cmd+R to rename. Right-click for Duplicate, Delete, Insert Audio Track and Color.'),
      ...trackButtons(t, i),
      info(vfield(h('div', 'vol'), volOpts(t, 'h')), 'Track Volume', VOL_INFO),
      info(vfield(h('div', 'pan'), panOptsFor(t, 'h')), 'Track Pan', PAN_INFO),
      meterEl(t.id, 'Track Meter'));
    hd.onpointerdown = e => { if (!e.button && !e.target.closest('button, .vf, input')) select(t.id, e); };
    hd.oncontextmenu = e => trackMenu(e, t);
    lane.oncontextmenu = e => laneMenu(e, t);
    acceptDrop(row, t.id);
    row.append(lane, hd);
    return row;
  }

  function returnRow(r, W) {
    const row = h('div', `trow ret${sel.anchor === r.id ? ' selected' : ''}${r.on ? '' : ' off'}`);
    row.style.setProperty('--c', r.color);
    const lane = info(h('div', 'lane rlane2'), 'Return Track', `${r.name} receives the signal each track sends to it with its Send ${r.id} knob (in the Mixer), and adds its effect. Select it to see its devices.`);
    lane.style.width = `${W}px`;
    lane.onpointerdown = e => { if (!e.button) selectReturn(r.id); };
    const hd = h('div', 'hdr');
    hd.append(h('div', 'strip'), nameEl(r, 'Return Track Title Bar', 'Click to select the return track and show its devices. Double-click or Cmd+R to rename it.'),
      ...returnButtons(r), h('div', 'btnspace'),
      info(vfield(h('div', 'vol'), volOpts(r, 'h')), 'Return Volume', VOL_INFO), info(vfield(h('div', 'pan'), panOptsFor(r, 'h')), 'Return Pan', PAN_INFO), meterEl(r.id, 'Return Meter'));
    hd.onpointerdown = e => { if (!e.button && !e.target.closest('button, .vf, input')) selectReturn(r.id); };
    hd.oncontextmenu = lane.oncontextmenu = e => returnMenu(e, r);
    acceptDrop(row, r.id);
    row.append(lane, hd);
    return row;
  }

  function clipEl(t, c) {
    const ppb = view.ppb, el = h('div', `clip${sel.clip === c.id ? ' sel' : ''}${c.rec ? ' rec' : ''}${c.on === false ? ' inactive' : ''}`);
    el.style.left = `${c.start * ppb}px`; el.style.width = `${Math.max(2, c.len * ppb)}px`;
    const nm = h('div', 'cname', { textContent: c.name }); nm.dataset.cn = c.id;
    const body = h('div', 'cbody');
    if (!c.rec) { body.style.backgroundImage = `url(${wave(c.sound)})`; body.style.backgroundSize = `${ppb}px 100%`; body.style.backgroundPositionX = `${-(((offsetOf(c) % 1) + 1) % 1) * ppb}px`; }
    const eL = h('div', 'edge l'), eR = h('div', 'edge r');
    el.append(nm, body, eL, eR);
    info(el, `Clip: ${c.name}`, `${c.rec ? 'A clip recorded on an armed track (this prototype does not capture audio, so it is silent). ' : 'An audio clip. '}Click its title bar to select it; drag the title bar to move it (snaps to the grid, hold Cmd to move freely; it overwrites clips it lands on); drag in the waveform to select time; drag its left or right edge to shorten or lengthen it. Delete removes it, Cmd+D duplicates, Cmd+E splits it at the insert marker, 0 deactivates it, Cmd+X/C/V cut, copy and paste. Right-click for more.`);
    info(eL, 'Clip Start', 'Drag to move the start of the clip (snaps to the grid; hold Cmd to move freely).'); info(eR, 'Clip End', 'Drag to change the length of the clip (snaps to the grid; hold Cmd to move freely).');
    info(body, `Clip: ${c.name}`, 'Like Live: drag in the waveform to select time (across clips and tracks), then cut, copy, split, loop or delete it. Click here to place the insert marker. To move the clip, drag its title bar; to select the whole clip, click its title bar.');
    el.onpointerdown = e => {
      if (e.button || e.target === body) return; // the waveform area selects time (handled by the lane)
      e.stopPropagation(); e.preventDefault();
      sel.clip = c.id; sel.device = null; sel.range = null;
      if (!sel.tracks.has(t.id)) { sel.tracks = new Set([t.id]); sel.anchor = t.id; }
      const mode = e.target === eL ? 'start' : e.target === eR ? 'end' : 'move';
      const before = snap(), x0 = e.clientX, s0 = c.start, l0 = c.len, o0 = offsetOf(c);
      let moved = false;
      const mv = ev => {
        const [, cc] = clipOf(c.id), x = (ev.clientX - x0) / view.ppb, free = ev.metaKey || ev.altKey, min = 1 / 32;
        if (!cc) return;
        if (mode === 'move') cc.start = Math.max(0, snapX(s0 + x, free));
        else if (mode === 'end') cc.len = Math.max(min, tidy(snapX(s0 + l0 + x, free) - s0));
        else { const ns = clamp(snapX(s0 + x, free), 0, tidy(s0 + l0 - min)); cc.len = tidy(l0 - (ns - s0)); cc.start = ns; cc.offset = tidy(o0 + ns - s0); }
        moved = cc.start !== s0 || cc.len !== l0;
        renderArrangement();
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        const [tt, cc] = clipOf(c.id);
        if (moved && cc) { carve(tt, cc); finish(before, mode === 'move' ? 'Move Clip' : 'Resize Clip', clipLog(mode === 'move' ? 'move' : 'resize', tt, cc, { from: s0, len: cc.len, source: 'drag' })); }
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
      render();
    };
    el.oncontextmenu = e => {
      if (e.target === body && sel.range?.tracks.includes(t.id)) return; // the lane's edit menu acts on the time selection
      sel.clip = c.id; sel.range = null; render();
      menu(e, [['Rename', 'Cmd+R', () => renameClip(c.id)], [c.on === false ? 'Activate Clip' : 'Deactivate Clip', '0', () => toggleClip(c.id, 'menu')], null, ...editItems(e)]);
    };
    return el;
  }

  function mainRow(W) {
    const row = h('div', 'trow main');
    const lane = info(h('div', 'lane mlane'), 'Main Track', 'Every track and return track is mixed into the Main track before you hear it.');
    lane.style.width = `${W}px`;
    const hd = h('div', 'hdr');
    hd.append(h('div', 'strip'), info(h('div', 'tname', { textContent: 'Main' }), 'Main Track', 'Every track and return track is mixed into the Main track before you hear it.'),
      info(vfield(h('div', 'vol'), mainOpts('h')), 'Main Volume', VOL_INFO), meterEl('main', 'Main Meter'));
    row.append(lane, hd);
    return row;
  }

  // ---------- Arrangement Mixer ----------
  function renderMixer() {
    stripsEl.replaceChildren();
    if (!view.mixer) return;
    state.tracks.forEach((t, i) => stripsEl.append(channelStrip(t, i)));
    state.returns.forEach(r => stripsEl.append(channelStrip(r, -1)));
    const m = h('div', 'mstrip main');
    m.append(info(h('div', 'stitle', { textContent: 'Main' }), 'Main Track', 'Every track and return track is mixed into the Main track before you hear it.'),
      h('div', 'sends'), h('div', 'mpan'), faderBox({ id: 'main' }, mainOpts('fader'), mainOpts('m')), h('div', 'mbtns'));
    stripsEl.append(m);
  }
  function faderBox(t, fo, bo) {
    const box = h('div', 'fbox'), col = h('div', 'fcol');
    col.append(info(vfield(h('div', 'fader'), fo), t.id === 'main' ? 'Main Volume Fader' : 'Volume Fader', `Drag the fader up/down to change the level (Shift = fine). ${VOL_INFO}`), meterEl(t.id, 'Meter'));
    box.append(info(vfield(h('div', 'vbox'), bo), 'Volume', VOL_INFO), col);
    return box;
  }
  function channelStrip(t, i) {
    const isRet = i < 0, selected = isRet ? sel.anchor === t.id : sel.tracks.has(t.id);
    const el = h('div', `mstrip${selected ? ' selected' : ''}${t.on ? '' : ' off'}`);
    el.style.setProperty('--c', t.color);
    const title = info(h('div', 'stitle', { textContent: t.name }), isRet ? 'Return Track Title Bar' : 'Track Title Bar', 'Click to select. Double-click to rename. Right-click for more options.');
    title.dataset.sn = t.id;
    title.onpointerdown = e => { if (e.button) return; if (isDouble(`m${t.id}`)) setTimeout(() => renameTrack(t.id, 'sn')); else if (isRet) selectReturn(t.id); else select(t.id, e); };
    title.oncontextmenu = e => (isRet ? returnMenu(e, t) : trackMenu(e, t));
    const sends = h('div', 'sends');
    if (!isRet) for (const r of state.returns) {
      const k = h('div', 'kbox');
      k.append(h('label', '', { textContent: r.id }), info(vfield(h('div', ''), sendOpts(t, r)), `Send ${r.id}`,
        `How much of this track is sent to return track ${r.name}, from -inf (none) to 0 dB. Drag up/down, or click and type a value. Delete resets it to -inf.`));
      sends.append(k);
    }
    const pan = h('div', 'mpan');
    pan.append(info(vfield(h('div', ''), panOptsFor(t, 'm', { knob: true })), isRet ? 'Return Pan' : 'Track Pan', PAN_INFO));
    const btns = h('div', 'mbtns');
    btns.append(...(isRet ? returnButtons(t) : trackButtons(t, i)));
    el.append(title, sends, pan, faderBox(t, volOpts(t, 'f', { fader: true }), volOpts(t, 'm')), btns);
    if (!isRet) acceptDrop(el, t.id);
    return el;
  }

  // ---------- Device View ----------
  function renderDevices() {
    const owner = current();
    devicesEl.replaceChildren();
    if (!owner) return;
    for (const d of owner.devices) {
      const folded = view.folded.has(d.id);
      const box = h('div', `device${sel.device === d.id ? ' sel' : ''}${d.on ? '' : ' off'}${folded ? ' folded' : ''}`);
      box.dataset.did = d.id;
      const title = h('div', 'dtitle');
      const act = info(h('button', `dact${d.on ? ' on' : ''}`), 'Device Activator', 'Turns the device on or off. A device that is off is bypassed and does not change the sound.');
      act.onclick = e => { e.stopPropagation(); toggleDevice(owner, d, 'click'); };
      title.append(act, h('span', '', { textContent: d.type }));
      info(title, `${d.type} Title Bar`, `${DEVICES[d.type].info} Click to select the device (Delete removes it). Drag left/right to reorder the chain. Double-click to fold or unfold it. Right-click for options.`);
      title.onpointerdown = e => {
        if (e.button || e.target.closest('button')) return;
        if (isDouble(d.id)) { view.folded.has(d.id) ? view.folded.delete(d.id) : view.folded.add(d.id); return renderDevices(); }
        const before = snap(), x0 = e.clientX, from = owner.devices.findIndex(x => x.id === d.id);
        let moving = false;
        const mv = ev => {
          if (!moving && Math.abs(ev.clientX - x0) < 6) return;
          moving = true;
          const list = anyById(owner.id).devices, cur = list.findIndex(x => x.id === d.id);
          const to = [...devicesEl.querySelectorAll('.device')].filter(b => b.dataset.did !== d.id && b.getBoundingClientRect().left + b.offsetWidth / 2 < ev.clientX).length;
          if (to !== cur) { list.splice(to, 0, ...list.splice(cur, 1)); renderDevices(); engine.sync(); }
        };
        const up = () => {
          removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
          if (moving) finish(before, 'Move Device', ['device', { action: 'move', track: where(owner.id), device: d.type, from, to: anyById(owner.id).devices.findIndex(x => x.id === d.id) }]);
        };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      };
      const params = h('div', 'dparams');
      if (!folded) for (const p of DEVICES[d.type].params) {
        const pb = h('div', 'param');
        pb.append(h('label', '', { textContent: p.label }),
          info(vfield(h('div', ''), paramOpts(owner, d, p)), `${d.type}: ${p.label}`, `Drag up/down to change (Shift = fine), or click and type a value and press Enter. Delete resets it to the default (${fmtParam(p, p.def)}).`));
        params.append(pb);
      }
      box.append(title, params);
      box.onpointerdown = () => { if (sel.device !== d.id) { sel.device = d.id; sel.clip = null; render(); } };
      box.oncontextmenu = e => { sel.device = d.id; render(); menu(e, [[d.on ? 'Deactivate' : 'Activate', '', () => toggleDevice(owner, d, 'menu')], [folded ? 'Unfold' : 'Fold', '', () => { folded ? view.folded.delete(d.id) : view.folded.add(d.id); renderDevices(); }], null, ['Delete', 'Delete', () => deleteDevice(d.id, 'menu')]]); };
      devicesEl.append(box);
    }
    devicesEl.append(info(h('div', 'dropz', { textContent: 'Drop Audio Effects Here' }), 'Device Chain', `The devices on ${owner.name}, processed from left to right. Drag an audio effect from the Browser here, or double-click it in the Browser, to add it.`));
  }

  // ---------- Browser ----------
  function renderBrowser() {
    const cats = $('#cats'), items = $('#items');
    cats.replaceChildren(...CATEGORIES.map(c => {
      const li = info(h('li', `${c === view.cat ? 'on' : ''}${CAT_INFO[c] ? '' : ' na'}`, { textContent: c }), c, CAT_INFO[c] ?? 'Not available in this prototype.');
      if (CAT_INFO[c]) li.onclick = () => { view.cat = c; view.item = null; renderBrowser(); };
      return li;
    }));
    const q = view.search.toLowerCase(), samples = view.cat === 'Samples';
    items.replaceChildren(...Object.keys(samples ? SAMPLES : DEVICES).filter(n => n.toLowerCase().includes(q)).map(n => {
      const li = h('li', `${n === view.item ? 'sel' : ''}${samples ? ' smp' : ''}`, { textContent: n, draggable: true });
      if (samples) info(li, n, 'An audio loop. Click to preview it. Drag it onto a track to add a 4-bar clip there, or into "Drop Files and Devices Here" (or double-click it) to create a new audio track with it.');
      else info(li, n, `${DEVICES[n].info} Double-click to add it to the selected track, or drag it onto a track or the Device View.`);
      li.onclick = () => { view.item = n; renderBrowser(); if (samples) engine.preview(SAMPLES[n]); };
      li.ondblclick = () => (samples ? insertAudioTrack('browser', { name: n, sample: n, start: Math.floor(T.marker) }) : current() && addDevice(current().id, n, 'browser'));
      li.ondragstart = e => { drag = { kind: samples ? 'sample' : 'device', name: n }; e.dataTransfer.setData('text/plain', n); e.dataTransfer.effectAllowed = 'copy'; };
      li.ondragend = () => setTimeout(() => (drag = null));
      return li;
    }));
  }

  function renderCtrl() {
    vfield($('#tempo'), tempoField);
    $('#playBtn').classList.toggle('on', engine.playing);
    $('#recBtn').classList.toggle('on', !!T.rec);
    $('#loopBtn').classList.toggle('on', T.loop);
    $('#metro').classList.toggle('on', T.metro);
    $('#followBtn').classList.toggle('on', T.follow);
    vfield($('#loopStart'), loopStartField);
    vfield($('#loopLen'), loopLenField);
    $('#gridBtn').textContent = gridLabel();
  }

  // Loop start and length in the control bar: drag (1 bar per 8 px), arrows (Shift = 1 beat), or type e.g. 5.1.1 / 8.0.0.
  const loopField = (fk, label, get, set, len) => ({
    fk, label, get, fmt: v => fmtPos(v, len), pos: () => 0, reset: get(), parse: v => parsePos(v, len), log: () => null,
    drag: (s, dy) => s - Math.round(dy / 8), step: sh => (sh ? 0.25 : 1), bump: (v, d) => v + d,
    set: v => { const n = +v; if (Number.isFinite(n)) { set(n); onEvent('transport', { action: 'loop region', start: T.loopStart, end: T.loopEnd }); } },
  });
  const loopStartField = loopField('loopStart', 'Loop Start', () => T.loopStart, n => { const l = T.loopEnd - T.loopStart; T.loopStart = tidy(Math.max(0, n)); T.loopEnd = tidy(T.loopStart + l); });
  const loopLenField = loopField('loopLen', 'Loop Length', () => T.loopEnd - T.loopStart, n => (T.loopEnd = tidy(T.loopStart + Math.max(1 / 16, n))), true);

  // ---------- animation: playhead, recording, meters, CPU ----------
  function frame() {
    const p = engine.position(), pos = p ?? T.marker, ppb = view.ppb;
    if (playhead) { playhead.style.left = `${pos * ppb}px`; playhead.hidden = p === null; markerEl.style.left = `${T.marker * ppb}px`; }
    $('#pos').textContent = fmtPos(pos);
    if (p !== null && T.follow) {
      const x = pos * ppb, vw = scroller.clientWidth - HDR;
      if (x < scroller.scrollLeft || x > scroller.scrollLeft + vw - 20) scroller.scrollLeft = x - 40;
    }
    if (T.rec && p !== null) {
      for (const [tid, cid] of T.rec.clips) { const c = byId(tid)?.clips.find(x => x.id === cid); if (c && p > c.start) c.len = Math.max(c.len, p - c.start); }
      if (performance.now() - T.rec.drawn > 200) { T.rec.drawn = performance.now(); renderArrangement(); }
    }
  }
  const lv = new Map();
  let cpuAt = 0;
  (function loop(now) {
    frame();
    const lev = engine.levels();
    for (const [id, els] of meters) {
      const peak = lev.get(id) ?? 0, target = peak > 0 ? dbToPos(20 * Math.log10(peak)) : 0, v = Math.max(target, (lv.get(id) ?? 0) * 0.88);
      lv.set(id, v);
      for (const el of els) el.style.height = `${v * 100}%`;
    }
    if (now - cpuAt > 700) { cpuAt = now; $('#cpu').textContent = `${engine.playing ? 3 + Math.round(Math.random() * 4) : 1} %`; }
    requestAnimationFrame(loop);
  })(0);

  // ---------- control bar, browser and status bar wiring ----------
  $('#playBtn').onclick = e => play(e.shiftKey);
  $('#stopBtn').onclick = stop;
  $('#recBtn').onclick = toggleRecord;
  $('#loopBtn').onclick = () => toggleLoop(false);
  $('#metro').onclick = () => { T.metro = !T.metro; onEvent('transport', { action: 'metronome', on: T.metro }); renderCtrl(); };
  $('#followBtn').onclick = () => { T.follow = !T.follow; onEvent('view', { follow: T.follow }); renderCtrl(); };
  $('#browserBtn').onclick = () => toggleView('browser');
  $('#infoBtn').onclick = () => toggleView('info');
  $('#detailBtn').onclick = () => toggleView('detail');
  $('#mixerBtn').onclick = () => toggleView('mixer');
  $('#gridBtn').onclick = e => gridMenu(e);
  let taps = [];
  $('#tap').onclick = () => {
    const now = performance.now();
    taps = [...taps.filter(x => now - x < 2000), now];
    if (taps.length >= 3) edit('tempo', null, Math.round((60000 / ((taps.at(-1) - taps[0]) / (taps.length - 1))) * 100) / 100, 'tap');
  };
  $('#search').oninput = e => { view.search = e.target.value; renderBrowser(); };
  $('#search').onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') e.target.blur(); };
  const detail = $('#detail');
  detail.ondragover = e => { if (drag?.kind === 'device') { e.preventDefault(); detail.classList.add('dragover'); } };
  detail.ondragleave = () => detail.classList.remove('dragover');
  detail.ondrop = e => { e.preventDefault(); detail.classList.remove('dragover'); if (current()) dropOn(current().id, e, 'drag'); };
  detail.onpointerdown = e => { if (e.target === detail || e.target === devicesEl) { sel.device = null; render(); } };
  scroller.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 0.9); } }, { passive: false });

  // Info View: name and function of whatever is under the mouse.
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-it]');
    if (el) { $('#infoTitle').textContent = el.dataset.it; $('#infoText').textContent = el.dataset.ih; }
  });

  // ---------- Live 12 keyboard shortcuts ----------
  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea, dialog') || (!menuEl.hidden && e.key !== 'Escape')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key, low = k.toLowerCase();
    if (k === ' ') { e.shiftKey ? play(true) : engine.playing ? stop() : play(); }
    else if (k === 'F9') toggleRecord();
    else if (mod && e.altKey && e.code === 'KeyB') toggleView('browser');
    else if (mod && e.altKey && e.code === 'KeyL') toggleView('detail');
    else if (mod && e.altKey && e.code === 'KeyM') toggleView('mixer');
    else if (mod && !e.shiftKey && low === 't') insertAudioTrack('shortcut');
    else if (mod && e.shiftKey && low === 'x') timeOp('cut time', 'shortcut');
    else if (mod && e.shiftKey && low === 'v') timeOp('paste time', 'shortcut');
    else if (mod && e.shiftKey && low === 'd') timeOp('duplicate time', 'shortcut');
    else if (mod && e.shiftKey && (k === 'Delete' || k === 'Backspace')) timeOp('delete time', 'shortcut');
    else if (mod && low === 'i') timeOp('insert silence', 'shortcut');
    else if (mod && k === '1') setGrid(narrowGrid);
    else if (mod && k === '2') setGrid(widenGrid);
    else if (mod && k === '3') setGrid(g => (g.triplet = !g.triplet));
    else if (mod && k === '4') setGrid(g => (g.snap = !g.snap));
    else if (mod && low === 'd') duplicateSel('shortcut');
    else if (mod && low === 'r') renameSel();
    else if (mod && low === 'e') splitClips('shortcut');
    else if (mod && low === 'c') copySel(false, 'shortcut');
    else if (mod && low === 'x') copySel(true, 'shortcut');
    else if (mod && low === 'v') pasteSel('shortcut');
    else if (mod && low === 'a') {
      const end = Math.max(0, ...state.tracks.flatMap(t => t.clips.map(c => c.start + c.len)));
      sel = { tracks: new Set(allIds()), anchor: state.tracks[0].id, clip: null, device: null, range: end ? { start: 0, end, tracks: allIds() } : null };
      render();
    }
    else if (mod && low === 'z') e.shiftKey ? restore(redo, undo, 'Redo') : restore(undo, redo, 'Undo');
    else if (mod && low === 'y') restore(redo, undo, 'Redo');
    else if (mod && low === 'l') toggleLoop(true);
    else if (mod && low === 'f') $('#search').focus();
    else if (mod) return;
    else if (k === '?') toggleView('info');
    else if (k === 'Delete' || k === 'Backspace') deleteSel('shortcut');
    else if (/^F[1-8]$/.test(k)) { const t = state.tracks[+k.slice(1) - 1]; if (t) edit('mute', t.id, t.on, 'shortcut'); }
    else if (k === '0') (sel.clip ? toggleClip(sel.clip, 'shortcut') : toggleSel('mute'));
    else if (low === 's' && !e.altKey) toggleSel('solo');
    else if (low === 'c' && !e.altKey) toggleSel('arm');
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      const i = clamp(idx(sel.anchor) + (k === 'ArrowDown' ? 1 : -1), 0, state.tracks.length - 1);
      select(state.tracks[i].id, { shiftKey: e.shiftKey });
    }
    else if (k === '+' || k === '=') zoom(1.25);
    else if (k === '-') zoom(0.8);
    else if (k === 'Escape') { menuEl.hidden = true; sel.clip = sel.device = sel.range = null; render(); }
    else return;
    e.preventDefault();
    if (!['ArrowUp', 'ArrowDown', 'Escape'].includes(k)) onEvent('shortcut', { key: `${mod ? 'Cmd+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey && k.length > 1 ? 'Shift+' : ''}${k}`, selected: selIds().map(id => idx(id) + 1) });
  });

  // Buttons never take keyboard focus, so Space always means Play/Stop.
  document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  addEventListener('resize', render);
  view.ppb = clamp((scroller.clientWidth - HDR) / 26, 16, 80);
  render();

  return {
    get state() { return state; },
    setState(full) {
      const { metronome, transport, marker, loop, view: _, ...core } = full;
      engine.stop(); T.rec = null; T.marker = T.stopPos = marker ?? 0;
      if (loop) Object.assign(T, { loop: !!loop.on, loopStart: loop.start, loopEnd: loop.end });
      T.metro = !!metronome;
      state = hydrate(core);
      loaded = state.tracks.map(t => ({ id: t.id, ...coreOf(t) }));
      undo.length = redo.length = 0;
      sel = { tracks: new Set([state.tracks[0].id]), anchor: state.tracks[0].id, clip: null, device: null };
      changed();
    },
    // The study tracks in their original order, matched by id, so inserted/moved tracks don't shift the scoring.
    // A deleted study track scores as a changed (blank) name.
    scoringState() {
      return { tempo: state.tempo, tracks: loaded.map(l => { const t = byId(l.id); return t ? coreOf(t) : { ...coreOf(l), name: '' }; }) };
    },
    session,
    // Applies the assistant's tool calls as one undoable step, then starts/stops the transport if they asked for it.
    // Returns the calls' errors and the list of changes (describeChanges) for the person to check.
    applyCalls(calls, source = 'assistant') {
      const before = session(), { state: out, errors } = applyCalls(before, calls), changes = describeChanges(before, out);
      const { metronome, transport, marker, loop, view: _, ...core } = out;
      change('Assistant', () => {
        state = core;
        Object.assign(T, { metro: metronome, loop: loop.on, loopStart: loop.start, loopEnd: loop.end });
        if (marker !== before.marker) T.marker = T.stopPos = marker;
      }, ['assistant', { source, calls, errors, changes }]);
      const restart = transport === 'playing' && marker !== before.marker;
      if (transport !== before.transport || restart) {
        if (transport === 'recording') { if (!T.rec) startRecord(); }
        else if (transport === 'playing') { if (T.rec) endRecord(); if (engine.playing) engine.play(T.marker); else play(); }
        else if (engine.playing) stop();
      }
      return { errors, changes };
    },
    undo: () => restore(undo, redo, 'Undo'),
    apply(actions, source) { // old single-op format (applyAction); returns per-action errors
      const errors = [];
      change('Assistant', () => {
        for (const a of actions) {
          const i = a.op === 'tempo' ? -1 : resolveTrack(state, a.track);
          const before = a.op === 'tempo' ? state.tempo : state.tracks[i] ? coreOf(state.tracks[i]) : null;
          const err = applyAction(state, a);
          errors.push(err);
          if (!err) onEvent('edit', { ...a, source, before });
        }
      });
      return errors;
    },
    stop() { if (engine.playing) stop(); },
    render,
  };
}
