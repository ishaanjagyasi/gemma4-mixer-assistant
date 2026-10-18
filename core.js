// Session state, the assistant's tools, applying tool calls, scoring and error tagging.
// Shared by the browser app, the dataset generator, the evaluation script and the training export.
import { DEVICES, SAMPLES, COLORS, deviceDefaults, fmtParam } from './catalog.js';

export const TRACKS = [
  ['Kick', '#ff8f3d'], ['Snare', '#ffd23f'], ['Hats', '#b8e05a'], ['Bass', '#3fd1a2'],
  ['Keys', '#47c1f0'], ['Pad', '#8d8cf5'], ['Lead Vox', '#f27ac6'], ['Back Vox', '#d6a6f2'],
];
export const VOL_MIN = -70, VOL_MAX = 6; // VOL_MIN is shown as -inf
export const EFFECTS = Object.keys(DEVICES);

export const clone = s => JSON.parse(JSON.stringify(s));
export const defaultState = () => ({
  tempo: 120,
  tracks: TRACKS.map(([name, color]) => ({ name, color, vol: 0, pan: 0, on: true, solo: false, arm: false })),
});

export const fmtVol = v => (v <= VOL_MIN ? '-inf' : v.toFixed(1));
export const fmtPan = p => (p === 0 ? 'C' : `${Math.abs(p)}${p < 0 ? 'L' : 'R'}`);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const tidy = x => Math.round(x * 1e6) / 1e6;
const norm = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parsePan(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().toUpperCase();
  if (s === 'C' || s === 'CENTER' || s === 'CENTRE') return 0;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([LR])?$/);
  if (!m) return NaN;
  return m[2] === 'L' ? -Math.abs(+m[1]) : m[2] === 'R' ? Math.abs(+m[1]) : +m[1];
}
function parseBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'on', '1', 'yes'].includes(s)) return true;
  if (['false', 'off', '0', 'no'].includes(s)) return false;
  return null;
}
function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase().replace(/\s*(db|bpm|ms|s|hz|%|percent)$/, '');
  return s === '-inf' ? VOL_MIN : s === '' ? NaN : Number(s);
}

// ---------- simple mixer edits used directly by the app's controls ----------

export function resolveTrack(state, t) {
  if (typeof t === 'number' || /^\s*\d+\s*$/.test(t ?? '')) {
    const i = Number(t) - 1;
    return i >= 0 && i < state.tracks.length ? i : -1;
  }
  const s = String(t ?? '').trim().toLowerCase();
  return state.tracks.findIndex(tr => tr.name.toLowerCase() === s);
}
// Applies one mixer edit in place ({ op: volume|pan|mute|solo|arm|rename|tempo, track, value }). Returns an error string or null.
export function applyAction(state, a) {
  if (a.op === 'tempo') {
    const t = parseNum(a.value);
    if (!Number.isFinite(t)) return `bad tempo ${a.value}`;
    state.tempo = clamp(t, 20, 999);
    return null;
  }
  const i = resolveTrack(state, a.track);
  if (i < 0) return `unknown track ${a.track}`;
  const tr = state.tracks[i];
  if (a.op === 'volume') {
    const v = parseNum(a.value);
    if (!Number.isFinite(v)) return `bad volume ${a.value}`;
    tr.vol = clamp(v, VOL_MIN, VOL_MAX);
  } else if (a.op === 'pan') {
    const p = parsePan(a.value);
    if (!Number.isFinite(p)) return `bad pan ${a.value}`;
    tr.pan = clamp(Math.round(p), -50, 50);
  } else if (a.op === 'rename') {
    const n = String(a.value ?? '').trim();
    if (!n) return 'empty name';
    tr.name = n;
  } else if (['mute', 'solo', 'arm'].includes(a.op)) {
    const b = parseBool(a.value);
    if (b === null) return `bad ${a.op} value ${a.value}`;
    if (a.op === 'mute') tr.on = !b; else tr[a.op] = b;
  } else return `unknown op ${a.op}`;
  return null;
}

// ---------- the assistant's tools ----------

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const TRACK = { type: 'string', description: 'Track name' };
const TARGET = { type: 'string', description: 'Track name, "A Reverb", "B Delay" or "Main"' };
const BOOL = description => ({ type: 'boolean', ...(description ? { description } : {}) });
const NUM = description => ({ type: 'number', ...(description ? { description } : {}) });
const EFFECT = { type: 'string', enum: EFFECTS };
const BAR = description => ({ type: 'integer', ...(description ? { description } : {}) });

// Kept short: the tools are sent with every request (and every training example). The system prompt explains the vocabulary.
export const TOOLS = [
  fn('set_volume', 'Set a volume in dB, or change it (relative).', { track: TARGET, db: NUM('dB; -70 = -inf'), relative: BOOL('db is a change') }, ['track', 'db']),
  fn('set_pan', 'Pan: -50 hard left, 0 center, 50 hard right.', { track: TARGET, pan: NUM('-50 to 50') }, ['track', 'pan']),
  fn('set_mute', 'Mute or unmute.', { track: TARGET, muted: BOOL() }, ['track', 'muted']),
  fn('set_solo', 'Solo or unsolo.', { track: TARGET, soloed: BOOL() }, ['track', 'soloed']),
  fn('set_arm', 'Arm or disarm for recording.', { track: TRACK, armed: BOOL() }, ['track', 'armed']),
  fn('set_send', 'Set a send level (A = A Reverb, B = B Delay), or change it (relative).', { track: TRACK, send: { type: 'string', enum: ['A', 'B'] }, db: NUM('dB, -70 to 0'), relative: BOOL('db is a change') }, ['track', 'send', 'db']),
  fn('insert_track', 'Insert a new audio track.', { name: { type: 'string' }, after: { type: 'string', description: 'Track it goes after (default: at the end)' } }),
  fn('delete_track', 'Delete a track.', { track: TRACK }, ['track']),
  fn('duplicate_track', 'Duplicate a track (copy goes right after it).', { track: TRACK }, ['track']),
  fn('rename_track', 'Rename a track.', { track: TARGET, name: { type: 'string' } }, ['track', 'name']),
  fn('set_track_color', 'Change a track color.', { track: TARGET, color: { type: 'string', enum: Object.keys(COLORS) } }, ['track', 'color']),
  fn('add_effect', 'Add an effect at the end of the device chain.', { track: TARGET, effect: EFFECT }, ['track', 'effect']),
  fn('remove_effect', 'Remove an effect.', { track: TARGET, effect: EFFECT }, ['track', 'effect']),
  fn('set_effect_on', 'Turn an effect on, or off (bypass).', { track: TARGET, effect: EFFECT, on: BOOL() }, ['track', 'effect', 'on']),
  fn('set_effect_param', 'Set an effect parameter (as named in the session), or change it (relative).', { track: TARGET, effect: EFFECT, param: { type: 'string' }, value: NUM('in the parameter\'s unit'), relative: BOOL('value is a change') }, ['track', 'effect', 'param', 'value']),
  fn('set_tempo', 'Set the tempo, or change it (relative).', { bpm: NUM(), relative: BOOL('bpm is a change') }, ['bpm']),
  fn('set_metronome', 'Metronome (click) on or off.', { on: BOOL() }, ['on']),
  fn('set_loop', 'Loop on/off and/or the looped bars.', { on: BOOL(), start_bar: BAR('first bar'), length_bars: NUM('length in bars') }),
  fn('play', 'Start playback.', { from_bar: BAR('optional start bar') }),
  fn('stop', 'Stop playback or recording.', {}),
  fn('record', 'Start recording onto armed tracks.', {}),
  fn('add_sample', 'Place a Browser sample on a track as a new clip.', { track: TRACK, sample: { type: 'string', enum: Object.keys(SAMPLES) }, bar: BAR('start bar'), length_bars: NUM('default 4') }, ['track', 'sample', 'bar']),
  fn('delete_range', 'Delete audio on a track from from_bar to to_bar (both included).', { track: TRACK, from_bar: BAR(), to_bar: BAR() }, ['track', 'from_bar', 'to_bar']),
  fn('duplicate_range', 'Copy bars from_bar..to_bar on a track and place the copy right after.', { track: TRACK, from_bar: BAR(), to_bar: BAR() }, ['track', 'from_bar', 'to_bar']),
];
export const TOOL_NAMES = TOOLS.map(t => t.function.name);

// How each track is named to the model: its name, or "Snare #2" when several tracks share a name (Live allows that,
// e.g. after duplicating a track), so the model can point at one of them.
export function trackLabels(s) {
  const count = {}, seen = {};
  for (const t of s.tracks) count[norm(t.name)] = (count[norm(t.name)] ?? 0) + 1;
  return s.tracks.map(t => (count[norm(t.name)] > 1 ? `${t.name} #${(seen[norm(t.name)] = (seen[norm(t.name)] ?? 0) + 1)}` : t.name));
}
// Finds a track ("Kick", "Snare #2", "track 3", 3), a return track ("A Reverb", "return A") or Main. A name that
// several tracks share is refused rather than guessed.
export function findTarget(s, ref, { tracks = true, returns = true, main = false } = {}) {
  const r = String(ref ?? '').trim();
  const num = typeof ref === 'number' ? ref : /^(track\s*)?\d+$/i.test(r) ? parseInt(r.replace(/\D/g, ''), 10) : null;
  if (num !== null) return tracks && s.tracks[num - 1] ? { kind: 'track', obj: s.tracks[num - 1] } : null;
  const n = norm(r);
  if (tracks) {
    const labels = trackLabels(s), byLabel = labels.findIndex(l => l.toLowerCase() === r.toLowerCase());
    if (byLabel >= 0) return { kind: 'track', obj: s.tracks[byLabel] };
    const same = s.tracks.filter(x => norm(x.name) === n);
    if (same.length > 1) fail(`"${r}" could be ${same.map(x => labels[s.tracks.indexOf(x)]).join(' or ')}`);
    if (same.length) return { kind: 'track', obj: same[0] };
  }
  if (returns) {
    const rt = s.returns.find(x => [norm(x.name), norm(x.id), `return${norm(x.id)}`, norm(x.name.slice(2)), `${norm(x.name.slice(2))}return`, `send${norm(x.id)}`].includes(n));
    if (rt) return { kind: 'return', obj: rt };
  }
  if (main && ['main', 'master', 'mainout', 'masterbus', 'mainoutput', 'stereoout'].includes(n)) return { kind: 'main', obj: s.main };
  return null;
}
const EFFECT_ALIAS = { eq: 'EQ Eight', eq8: 'EQ Eight', equalizer: 'EQ Eight', comp: 'Compressor', verb: 'Reverb', echo: 'Delay', saturation: 'Saturator', filter: 'Auto Filter', lowpass: 'Auto Filter', gain: 'Utility' };
const PARAM_ALIAS = { mix: 'Dry/Wet', wet: 'Dry/Wet', drywet: 'Dry/Wet', amount: 'Dry/Wet', threshold: 'Thresh', frequency: 'Freq', cutoff: 'Freq', resonance: 'Res', q: 'Res', low: 'Low', lows: 'Low', lowend: 'Low', bass: 'Low', mids: 'Mid', middle: 'Mid', highs: 'High', top: 'High', treble: 'High', length: 'Decay', size: 'Decay', pan: 'Balance' };
const effectName = e => EFFECTS.find(x => norm(x) === norm(e)) ?? EFFECT_ALIAS[norm(e)];
const sampleName = x => { const n = norm(x).replace(/loop$/, ''); return Object.keys(SAMPLES).find(k => norm(k) === norm(x) || norm(k).replace(/loop$/, '') === n); };
const colorHex = c => COLORS[String(c ?? '').toLowerCase().trim()] ?? COLORS[{ gray: 'grey', violet: 'purple', teal: 'cyan', lightblue: 'light blue' }[norm(c)]];

const fail = msg => { throw new Error(msg); };
const need = (x, what) => x ?? fail(`unknown ${what}`);
const num = (v, what) => { const n = parseNum(v); return Number.isFinite(n) ? n : fail(`bad ${what} ${v}`); };
const bool = (v, what) => { const b = parseBool(v); return b === null ? fail(`bad ${what} ${v}`) : b; };
const rel = a => parseBool(a.relative) === true;
const bar = (v, what) => { const b = num(v, what); return b >= 1 ? b - 1 : fail(`bad ${what} ${v}`); };
const newId = (s, p) => `${p}${s.nextId = (s.nextId ?? 1) + 1}`;

// Clip editing on track t (positions in bars from 0). `offset` is where in its audio a clip starts.
const offsetOf = c => c.offset ?? c.start;
export function cutOut(s, t, a, b) {
  t.clips = t.clips.flatMap(c => {
    if (c.start + c.len <= a + 1e-9 || c.start >= b - 1e-9) return [c];
    const out = [];
    if (c.start < a) out.push({ ...c, len: tidy(a - c.start) });
    if (c.start + c.len > b) out.push({ ...c, id: c.start < a ? newId(s, 'C') : c.id, start: b, len: tidy(c.start + c.len - b), offset: tidy(offsetOf(c) + b - c.start) });
    return out;
  });
}
const extract = (t, a, b) => t.clips.filter(c => c.start < b - 1e-9 && c.start + c.len > a + 1e-9).map(c => {
  const x = Math.max(a, c.start), y = Math.min(b, c.start + c.len);
  return { ...c, start: tidy(x - a), len: tidy(y - x), offset: tidy(offsetOf(c) + x - c.start) };
});
function place(s, t, c) { cutOut(s, t, c.start, c.start + c.len); t.clips.push(c); t.clips.sort((x, y) => x.start - y.start); }

const device = (t, e) => need(t.devices.find(d => d.type === effectName(e)), `effect ${e} on ${t.name}`);
const vol = o => o.vol <= VOL_MIN ? VOL_MIN : o.vol;
const HANDLERS = {
  set_volume(s, a) {
    const t = need(findTarget(s, a.track, { main: true }), `track ${a.track}`).obj, v = num(a.db, 'volume');
    t.vol = Math.round(clamp(rel(a) ? vol(t) + v : v, VOL_MIN, VOL_MAX) * 10) / 10;
  },
  set_pan(s, a) {
    const t = need(findTarget(s, a.track), `track ${a.track}`).obj, p = parsePan(a.pan);
    t.pan = Number.isFinite(p) ? clamp(Math.round(p), -50, 50) : fail(`bad pan ${a.pan}`);
  },
  set_mute(s, a) { need(findTarget(s, a.track), `track ${a.track}`).obj.on = !bool(a.muted, 'muted'); },
  set_solo(s, a) { need(findTarget(s, a.track), `track ${a.track}`).obj.solo = bool(a.soloed, 'soloed'); },
  set_arm(s, a) { need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj.arm = bool(a.armed, 'armed'); },
  set_send(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj, r = need(findTarget(s, a.send, { tracks: false }), `send ${a.send}`).obj, v = num(a.db, 'send');
    t.sends[r.id] = Math.round(clamp(rel(a) ? Math.max(VOL_MIN, t.sends[r.id]) + v : v, VOL_MIN, 0) * 10) / 10;
  },
  insert_track(s, a) {
    const after = a.after ? need(findTarget(s, a.after, { returns: false }), `track ${a.after}`).obj : null;
    const at = after ? s.tracks.indexOf(after) + 1 : s.tracks.length, id = newId(s, 'N');
    const palette = Object.values(COLORS);
    s.tracks.splice(at, 0, { id, name: String(a.name ?? '').trim() || `${at + 1} Audio`, color: palette[s.nextId % palette.length], group: 'other', vol: 0, pan: 0, on: true, solo: false, arm: false, sends: { A: VOL_MIN, B: VOL_MIN }, devices: [], clips: [] });
  },
  delete_track(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj;
    if (s.tracks.length === 1) fail('cannot delete the last track');
    s.tracks.splice(s.tracks.indexOf(t), 1);
  },
  duplicate_track(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj, c = clone(t);
    c.id = newId(s, 'N'); c.clips.forEach(x => (x.id = newId(s, 'C'))); c.devices.forEach(x => (x.id = newId(s, 'D')));
    s.tracks.splice(s.tracks.indexOf(t) + 1, 0, c);
  },
  rename_track(s, a) {
    const n = String(a.name ?? '').trim();
    need(findTarget(s, a.track), `track ${a.track}`).obj.name = n || fail('empty name');
  },
  set_track_color(s, a) { need(findTarget(s, a.track), `track ${a.track}`).obj.color = need(colorHex(a.color), `color ${a.color}`); },
  add_effect(s, a) {
    const t = need(findTarget(s, a.track), `track ${a.track}`).obj, type = need(effectName(a.effect), `effect ${a.effect}`);
    t.devices.push({ id: newId(s, 'D'), type, on: true, params: deviceDefaults(type) });
  },
  remove_effect(s, a) { const t = need(findTarget(s, a.track), `track ${a.track}`).obj, d = device(t, a.effect); t.devices.splice(t.devices.indexOf(d), 1); },
  set_effect_on(s, a) { device(need(findTarget(s, a.track), `track ${a.track}`).obj, a.effect).on = bool(a.on, 'on'); },
  set_effect_param(s, a) {
    const d = device(need(findTarget(s, a.track), `track ${a.track}`).obj, a.effect), ps = DEVICES[d.type].params;
    const p = need(ps.find(x => norm(x.label) === norm(a.param)) ?? ps.find(x => x.label === PARAM_ALIAS[norm(a.param)]), `parameter ${a.param} on ${d.type}`);
    const dec = { Hz: 0, dB: 1, '%': 0, ms: 0, s: 2, ':1': 1, '': 0 }[p.unit], v = num(a.value, 'value');
    d.params[p.label] = Math.round(clamp(rel(a) ? d.params[p.label] + v : v, p.min, p.max) * 10 ** dec) / 10 ** dec;
  },
  set_tempo(s, a) { const v = num(a.bpm, 'tempo'); s.tempo = Math.round(clamp(rel(a) ? s.tempo + v : v, 20, 999) * 100) / 100; },
  set_metronome(s, a) { s.metronome = bool(a.on, 'on'); },
  set_loop(s, a) {
    const len = s.loop.end - s.loop.start;
    if (a.start_bar !== undefined && a.start_bar !== null) { s.loop.start = bar(a.start_bar, 'start_bar'); s.loop.end = s.loop.start + len; }
    if (a.length_bars !== undefined && a.length_bars !== null) { const l = num(a.length_bars, 'length_bars'); s.loop.end = l > 0 ? tidy(s.loop.start + l) : fail(`bad length_bars ${l}`); }
    s.loop.on = a.on === undefined || a.on === null ? true : bool(a.on, 'on');
  },
  play(s, a) { if (a.from_bar !== undefined && a.from_bar !== null) s.marker = bar(a.from_bar, 'from_bar'); s.transport = 'playing'; },
  stop(s) { s.transport = 'stopped'; },
  record(s) { s.transport = 'recording'; },
  add_sample(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj, name = need(sampleName(a.sample), `sample ${a.sample}`);
    const len = a.length_bars === undefined || a.length_bars === null ? 4 : num(a.length_bars, 'length_bars');
    place(s, t, { id: newId(s, 'C'), name, start: bar(a.bar, 'bar'), len: len > 0 ? len : fail(`bad length_bars ${len}`), offset: 0, sound: SAMPLES[name], on: true });
  },
  delete_range(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj, x = bar(a.from_bar, 'from_bar'), y = num(a.to_bar, 'to_bar');
    cutOut(s, t, x, y > x ? y : fail(`bad to_bar ${a.to_bar}`));
  },
  duplicate_range(s, a) {
    const t = need(findTarget(s, a.track, { returns: false }), `track ${a.track}`).obj, x = bar(a.from_bar, 'from_bar'), y = num(a.to_bar, 'to_bar');
    if (y <= x) fail(`bad to_bar ${a.to_bar}`);
    for (const c of extract(t, x, y)) place(s, t, { ...c, id: newId(s, 'C'), start: tidy(y + c.start) });
  },
};

// A tool call is { name, arguments } (arguments may be a JSON string), or Ollama's { function: { name, arguments } }.
export function applyCall(s, call) {
  const name = call?.name ?? call?.function?.name;
  let args = call?.arguments ?? call?.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return `bad arguments for ${name}`; } }
  if (!HANDLERS[name]) return `unknown tool ${name}`;
  try { HANDLERS[name](s, args ?? {}); return null; } catch (e) { return `${name}: ${e.message}`; }
}
export function applyCalls(state, calls) {
  const s = clone(state), errors = [];
  for (const c of calls ?? []) { const e = applyCall(s, c); if (e) errors.push(e); }
  return { state: s, errors };
}

// ---------- comparison / scoring ----------
// A session is compared as a set of facts ("t:T3.vol" = -10, "loop.on" = true ...). Tracks are matched by id, so
// inserted tracks (ids from nextId) line up when the same tracks are inserted in the same order.

const r3 = x => Math.round(x * 1000) / 1000;
const clipSig = t => t.clips.filter(c => c.len > 1e-6).map(c => `${r3(c.start)}+${r3(c.len)}:${c.sound ?? 'rec'}@${r3(offsetOf(c))}${c.on === false ? ' off' : ''}`).sort().join(' ');
export function facts(s) {
  const F = new Map();
  F.set('tempo', s.tempo); F.set('metronome', !!s.metronome); F.set('transport', s.transport ?? 'stopped'); F.set('marker', r3(s.marker ?? 0));
  F.set('loop.on', !!s.loop?.on); F.set('loop.start', r3(s.loop?.start ?? 0)); F.set('loop.end', r3(s.loop?.end ?? 0));
  F.set('main.vol', s.main?.vol ?? 0); F.set('order', s.tracks.map(t => t.id).join(','));
  const strip = (p, t) => {
    for (const f of ['name', 'vol', 'pan', 'on', 'solo', 'color']) F.set(`${p}.${f}`, t[f]);
    F.set(`${p}.fx`, t.devices.map(d => `${d.type}${d.on ? '' : ' (off)'}`).join(' > '));
    const seen = {};
    for (const d of t.devices) { const n = (seen[d.type] = (seen[d.type] ?? 0) + 1); for (const [k, v] of Object.entries(d.params)) F.set(`${p}.fx.${d.type}#${n}.${k}`, v); }
  };
  for (const t of s.tracks) {
    const p = `t:${t.id}`;
    F.set(`${p}.exists`, true); strip(p, t);
    F.set(`${p}.arm`, t.arm); F.set(`${p}.send.A`, t.sends?.A ?? VOL_MIN); F.set(`${p}.send.B`, t.sends?.B ?? VOL_MIN); F.set(`${p}.clips`, clipSig(t));
  }
  for (const r of s.returns ?? []) strip(`r:${r.id}`, r);
  return F;
}
export const fieldOf = k => (/^[tr]:[^.]+\./.test(k) ? k.replace(/^[tr]:[^.]+\./, '') : k);
const trackOf = k => /^t:[^.]+/.exec(k)?.[0];
// What a track that doesn't exist on one side is compared as: a new, default track.
const DEFAULT_FACT = { exists: false, name: '', vol: 0, pan: 0, on: true, solo: false, arm: false, 'send.A': VOL_MIN, 'send.B': VOL_MIN, fx: '', clips: '' };
export function factValue(F, k) {
  const t = trackOf(k);
  return !t || F.has(`${t}.exists`) ? F.get(k) : DEFAULT_FACT[fieldOf(k)];
}
export function same(k, a, b) {
  const f = fieldOf(k);
  if (typeof a === 'number' && typeof b === 'number') {
    // Tolerances are tight enough to tell apart the precise values requests use (e.g. -7.5 vs -7 dB, 126.5 BPM).
    if (/^(vol|main\.vol|send\.[AB])$/.test(f)) return (a <= VOL_MIN && b <= VOL_MIN) || Math.abs(a - b) <= 0.25;
    if (f === 'pan') return Math.abs(a - b) <= 1;
    if (f === 'tempo') return Math.abs(a - b) <= 0.25;
    const m = /^fx\.(.+)#\d+\.(.+)$/.exec(f);
    if (m) {
      const p = DEVICES[m[1]]?.params.find(x => x.label === m[2]);
      if (!p) return Math.abs(a - b) <= 1e-6;
      return p.log ? Math.abs(Math.log(a / b)) <= 0.01 : Math.abs(a - b) <= (p.max - p.min) * 0.005;
    }
    return Math.abs(a - b) <= 1e-3;
  }
  if (f === 'name' && typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase();
  return a === b;
}
// Facts that differ from a (before) to b (after). A removed track counts once (its "exists"); a new track is
// compared against a default track, so its name and any non-default settings count.
export function diff(a, b) {
  const A = facts(a), B = facts(b), out = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const t = trackOf(k), inA = !t || A.has(`${t}.exists`), inB = !t || B.has(`${t}.exists`), f = fieldOf(k);
    if (!inB && f !== 'exists') continue;
    if (!inA && !(f in DEFAULT_FACT)) continue;
    if (!same(k, factValue(A, k), factValue(B, k))) out.push(k);
  }
  return out;
}

// The differences between two sessions as short lines a person can check ("Kick: volume -6.0 → -8.0 dB"),
// in session order. Used by the assistant panel to show what a request changed.
export function describeChanges(a, b) {
  const A = facts(a), B = facts(b), out = [];
  const label = (s, id) => { const i = s.tracks.findIndex(t => t.id === id); return i >= 0 ? trackLabels(s)[i] : s.returns.find(r => r.id === id)?.name; };
  const nameOf = id => label(b, id) ?? label(a, id) ?? id;
  const colorName = c => Object.keys(COLORS).find(k => COLORS[k] === c) ?? c;
  const bars = (s, e) => `bars ${+(s + 1).toFixed(2)}-${+e.toFixed(2)}`;
  const fmt = (f, v) => {
    if (/^(vol|main\.vol|send\.[AB])$/.test(f)) return `${fmtVol(v)} dB`;
    if (f === 'pan') return fmtPan(v);
    const m = /^fx\.(.+)#\d+\.(.+)$/.exec(f), p = m && DEVICES[m[1]]?.params.find(x => x.label === m[2]);
    return p ? fmtParam(p, v) : f === 'fx' ? v || 'none' : String(v);
  };
  const LABEL = { vol: 'volume', pan: 'pan', 'send.A': 'send A (Reverb)', 'send.B': 'send B (Delay)', fx: 'effects', 'main.vol': 'Main volume' };
  const clipList = t => t.clips.filter(c => c.len > 1e-6).sort((x, y) => x.start - y.start).map(c => `${c.name} ${bars(c.start, c.start + c.len)}${c.on === false ? ' (off)' : ''}`).join(', ') || 'none';
  const keys = diff(a, b), added = new Map(); // new track id -> its settings, shown on the "Added track" line
  for (const k of keys) {
    const f = fieldOf(k), id = /^[tr]:([^.]+)/.exec(k)?.[1], who = id ? `${nameOf(id)}: ` : '';
    const was = factValue(A, k), now = factValue(B, k), isNew = k.startsWith('t:') && !A.has(`t:${id}.exists`);
    let line;
    if (f === 'exists') { if (now) { added.set(id, []); out.push({ id }); } else out.push(`Deleted track "${label(a, id)}" (was track ${a.tracks.findIndex(t => t.id === id) + 1})`); continue; }
    if (f === 'order') { if (!keys.some(x => x.endsWith('.exists'))) out.push('Track order changed'); continue; }
    if (isNew && ['name', 'color'].includes(f)) continue;
    if (f === 'on') line = now ? 'unmuted' : 'muted';
    else if (f === 'solo' || f === 'arm') line = `${now ? '' : 'un'}${f === 'solo' ? 'soloed' : 'armed'}`;
    else if (f === 'name') { out.push(`Renamed "${was}" → "${now}"`); continue; }
    else if (f === 'color') line = `color → ${colorName(now)}`;
    else if (f === 'clips') { const t = b.tracks.find(x => x.id === id); line = `clips → ${t ? clipList(t) : 'none'}`; }
    else if (f === 'metronome') line = `Metronome ${now ? 'on' : 'off'}`;
    else if (f === 'transport') line = now === 'playing' ? 'Play' : now === 'recording' ? 'Record' : 'Stop';
    else if (f === 'loop.on') line = `Loop ${now ? 'on' : 'off'}`;
    else if (f === 'loop.start' || f === 'loop.end') { if (out.some(x => String(x).startsWith('Loop region'))) continue; line = `Loop region → ${bars(b.loop.start, b.loop.end)}`; }
    else if (f === 'marker') line = `Insert marker → bar ${+(now + 1).toFixed(2)}`;
    else if (f === 'tempo') line = `Tempo ${was} → ${now} BPM`;
    else if (was === undefined || now === undefined) continue; // a parameter of an added/removed effect: the effects line covers it
    else { const m = /^fx\.(.+)#\d+\.(.+)$/.exec(f); line = `${m ? `${m[1]} ${m[2]}` : LABEL[f] ?? f}: ${isNew ? '' : `${fmt(f, was)} → `}${fmt(f, now)}`; }
    if (isNew) added.get(id)?.push(line); else out.push(who + line);
  }
  return out.map(x => (typeof x === 'string' ? x : `Added track "${nameOf(x.id)}"${added.get(x.id).length ? ` (${added.get(x.id).join('; ')})` : ''}`));
}

const prf = (tp, nPred, nReq) => {
  const p = nPred ? tp / nPred : 0, r = nReq ? tp / nReq : 0;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
};
export const ERROR_TYPES = ['omitted edit', 'wrong track', 'wrong value', 'relative read as absolute', 'pan side flipped',
  'wrong track structure', 'extra unrequested change', 'invalid tool call', 'parse error'];

// gt: the ground-truth tool calls (used to spot relative values read as absolute). callErrors: errors from applying the
// model's calls. parseError: the model output could not be parsed at all.
export function score(initial, target, predicted, gt = [], { parseError = false, callErrors = [] } = {}) {
  const req = diff(initial, target), chg = diff(initial, predicted);
  const I = facts(initial), Tg = facts(target), P = facts(predicted);
  const val = (F, k) => factValue(F, k);
  const ok = k => same(k, val(P, k), val(Tg, k));
  const tp = req.filter(ok).length;
  const res = { success: diff(target, predicted).length === 0, tp, n_required: req.length, n_changed: chg.length, ...prf(tp, chg.length, req.length), errors: [] };
  if (parseError) { res.errors.push({ type: 'parse error' }); return res; }
  for (const e of callErrors) res.errors.push({ type: 'invalid tool call', detail: e });
  const extras = chg.filter(k => !req.includes(k));
  const rels = gt.map(c => c.arguments ?? c.function?.arguments ?? {}).filter(a => parseBool(a.relative)).map(a => +(a.db ?? a.bpm ?? a.value));
  for (const k of req.filter(k => !ok(k))) {
    const pv = val(P, k), tv = val(Tg, k), f = fieldOf(k);
    if (f === 'order' || f === 'exists') { res.errors.push({ type: 'wrong track structure', key: k, got: pv, want: tv }); continue; }
    if (same(k, pv, val(I, k))) {
      const j = extras.findIndex(x => fieldOf(x) === f && same(x, val(P, x), tv));
      if (j >= 0) { res.errors.push({ type: 'wrong track', key: k, got: extras[j] }); extras.splice(j, 1); }
      else res.errors.push({ type: 'omitted edit', key: k });
      continue;
    }
    let type = 'wrong value';
    if (/^(vol|send\.[AB]|tempo)$/.test(f) && rels.some(d => Math.abs(Math.abs(pv) - Math.abs(d)) <= 0.5)) type = 'relative read as absolute';
    else if (f === 'pan' && tv !== 0 && Math.abs(pv + tv) <= 1) type = 'pan side flipped';
    res.errors.push({ type, key: k, got: pv, want: tv });
  }
  for (const k of extras) res.errors.push({ type: fieldOf(k) === 'order' || fieldOf(k) === 'exists' ? 'wrong track structure' : 'extra unrequested change', key: k, got: val(P, k) });
  // a track that is wrongly added or removed also changes the order; count it once
  if (res.errors.some(e => e.key?.endsWith('.exists'))) res.errors = res.errors.filter(e => e.key !== 'order');
  return res;
}

// ---------- utilities ----------

export function rng(seed) { // mulberry32
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function toCSV(rows) {
  const cols = Object.keys(rows[0]);
  const cell = v => {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}
