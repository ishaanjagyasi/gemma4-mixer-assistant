// Trial generator for the study set and the training set: a random session plus a producer's request in natural
// language (one or several clauses), with the ground-truth tool calls and the resulting session.
// Vague words have fixed meanings (VAGUE, PAN_WORDS, SEND_WORDS); prompt.js states the same rules to the model.
import { applyCalls, diff, clone, VOL_MIN, rng } from './core.js';
import { DEVICES, SAMPLES, COLORS, deviceDefaults } from './catalog.js';

// name, part, group, color, how people say it
const POOL = [
  ['Kick', 'kick', 'drums', '#ff8f3d', ['kick', 'the kick', 'the kick drum']],
  ['Snare', 'snare', 'drums', '#ffd23f', ['snare', 'the snare']],
  ['Clap', 'clap', 'drums', '#ffb35c', ['clap', 'the clap']],
  ['Hats', 'hats', 'drums', '#b8e05a', ['hats', 'the hats', 'the hi-hats']],
  ['Shaker', 'shaker', 'drums', '#9bd96b', ['shaker', 'the shaker']],
  ['Perc', 'perc', 'drums', '#e0c35a', ['perc', 'the percussion']],
  ['Bass', 'bass', 'bass', '#3fd1a2', ['bass', 'the bass', 'the bassline']],
  ['Sub', 'sub', 'bass', '#2fb38a', ['sub', 'the sub', 'the sub bass']],
  ['Keys', 'keys', 'music', '#47c1f0', ['keys', 'the keys']],
  ['Piano', 'keys', 'music', '#5ab0e8', ['piano', 'the piano']],
  ['Rhodes', 'keys', 'music', '#6fa3e0', ['rhodes', 'the rhodes']],
  ['Arp', 'arp', 'music', '#7f9cf5', ['arp', 'the arp']],
  ['Pad', 'pad', 'music', '#8d8cf5', ['pad', 'the pad']],
  ['Strings', 'pad', 'music', '#a08cf0', ['strings', 'the strings']],
  ['Lead Vox', 'lead', 'vocals', '#f27ac6', ['lead vox', 'the lead vocal', 'the lead vox']],
  ['Back Vox', 'choir', 'vocals', '#d6a6f2', ['back vox', 'the backing vocals', 'the BVs']],
  ['Harmony', 'choir', 'vocals', '#e0a0e8', ['harmony', 'the harmonies']],
  ['Adlibs', 'lead', 'vocals', '#f59ad0', ['adlibs', 'the adlibs']],
];
const STUDY = ['Kick', 'Snare', 'Hats', 'Bass', 'Keys', 'Pad', 'Lead Vox', 'Back Vox'];
const GROUP_ORDER = ['drums', 'bass', 'music', 'vocals'];
const GROUP_TEXT = { drums: ['the drums', 'all the drums', 'the drum tracks'], vocals: ['the vocals', 'all the vocal tracks', 'the vocal tracks'], all: ['everything', 'all the tracks', 'every track'] };
const FX_BY_GROUP = { drums: ['Compressor', 'EQ Eight', 'Saturator'], bass: ['Saturator', 'Compressor', 'EQ Eight', 'Auto Filter'], music: ['Reverb', 'EQ Eight', 'Auto Filter', 'Delay', 'Utility'], vocals: ['Compressor', 'EQ Eight', 'Delay', 'Reverb'] };
const CLIP_LAYOUTS = [[[0, 24]], [[4, 20]], [[0, 8], [12, 12]], [[4, 8], [16, 8]], [[0, 12]], [[8, 16]], [[4, 8], [12, 12]]];
const NEW_NAMES = ['808', 'Clap', 'Shaker', 'Sub', 'Rhodes', 'Strings', 'Hook', 'Harmony', 'Perc', 'Choir', 'Lead Synth', 'Guitar', 'Organ', 'Pluck', 'FX', 'Riser', 'Vox Chop', 'Top Loop', 'Bells', 'Chords'];

// Fixed meanings of vague words.
export const VAGUE = { 1: ['a touch', 'a hair', 'a tad', 'slightly'], 2: ['a bit', 'a little', 'a couple dB', 'a couple of dB'], 3: ['a few dB'], 6: ['a lot', 'quite a bit'] };
const FX_A = { 'EQ Eight': ['an EQ', 'an EQ Eight'], Compressor: ['a compressor', 'a comp'], Reverb: ['a reverb'], Delay: ['a delay', 'an echo'], Saturator: ['a saturator', 'some saturation'], 'Auto Filter': ['an auto filter', 'a filter', 'a low-pass filter'], Utility: ['a utility'] };
const FX_THE = { 'EQ Eight': ['EQ', 'EQ Eight'], Compressor: ['compressor', 'comp'], Reverb: ['reverb'], Delay: ['delay'], Saturator: ['saturator'], 'Auto Filter': ['filter', 'auto filter'], Utility: ['utility'] };
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function tools(R) {
  const pick = a => a[Math.floor(R() * a.length)], int = (a, b) => a + Math.floor(R() * (b - a + 1)), chance = p => R() < p;
  const pickW = w => { let x = R() * Object.values(w).reduce((a, b) => a + b, 0); for (const [k, v] of Object.entries(w)) if ((x -= v) < 0) return k; return Object.keys(w)[0]; };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // numbers as people say them: "-6", "minus 6", "six"
  const say = n => (Number.isInteger(n) && Math.abs(n) <= 20 && chance(0.12) ? `${n < 0 ? 'minus ' : ''}${WORDS[Math.abs(n)]}` : n < 0 && chance(0.2) ? `minus ${-n}` : String(n));
  return { pick, int, chance, pickW, shuffle, say };
}

// ---------- sessions ----------

export function session(R, layout) {
  const { pick, int, chance, shuffle } = tools(R);
  let n = 0;
  const id = p => `${p}${++n}`;
  const rows = layout === 'study' ? STUDY.map(x => POOL.find(p => p[0] === x))
    : shuffle([...POOL]).slice(0, int(5, 10)).sort((a, b) => GROUP_ORDER.indexOf(a[2]) - GROUP_ORDER.indexOf(b[2]));
  const devices = group => shuffle([...FX_BY_GROUP[group]]).slice(0, pick([0, 0, 1, 1, 2])).map(type => {
    const params = deviceDefaults(type);
    for (const p of DEVICES[type].params) if (chance(0.4)) params[p.label] = randParam(R, type, p.label) ?? params[p.label];
    return { id: id('gd'), type, on: !chance(0.12), params };
  });
  const tracks = rows.map(([name, sound, group, color], i) => ({
    id: `T${i + 1}`, name, color, group, vol: int(-18, -2), pan: chance(0.5) ? 0 : (chance(0.5) ? -1 : 1) * 5 * int(2, 8),
    on: !chance(0.15), solo: chance(0.06), arm: chance(0.1),
    sends: { A: chance(0.4) ? -int(6, 24) : VOL_MIN, B: chance(0.25) ? -int(10, 30) : VOL_MIN },
    devices: devices(group),
    clips: pick(CLIP_LAYOUTS).map(([start, len]) => ({ id: id('gc'), name, start, len, offset: start, sound, on: true })),
  }));
  const loopStart = pick([0, 4, 8, 12, 16]);
  return {
    tempo: int(85, 140), metronome: chance(0.3), transport: chance(0.25) ? 'playing' : 'stopped', marker: chance(0.3) ? int(1, 16) : 0,
    loop: { on: chance(0.3), start: loopStart, end: loopStart + pick([2, 4, 8]) }, main: { vol: chance(0.7) ? 0 : -int(1, 6) },
    tracks,
    returns: [
      { id: 'A', name: 'A Reverb', color: '#92a7ff', vol: chance(0.6) ? 0 : -int(1, 8), pan: 0, on: true, solo: false, devices: [{ id: id('gd'), type: 'Reverb', on: true, params: { ...deviceDefaults('Reverb'), 'Dry/Wet': 100, Decay: 2.5 } }] },
      { id: 'B', name: 'B Delay', color: '#5cffe8', vol: chance(0.6) ? 0 : -int(1, 8), pan: 0, on: true, solo: false, devices: [{ id: id('gd'), type: 'Delay', on: true, params: { ...deviceDefaults('Delay'), 'Dry/Wet': 100 } }] },
    ],
    nextId: 1,
  };
}
// Plausible values per effect parameter (also what requests ask for).
function randParam(R, type, label) {
  const { pick, int } = tools(R);
  const V = {
    'Reverb.Decay': () => pick([0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6]), 'Reverb.Dry/Wet': () => 5 * int(2, 18), 'Delay.Dry/Wet': () => 5 * int(2, 18),
    'Delay.Time': () => pick([125, 250, 375, 500, 750]), 'Delay.Feedback': () => 10 * int(1, 8),
    'Compressor.Thresh': () => -int(6, 36), 'Compressor.Ratio': () => pick([2, 3, 4, 6, 8, 10]), 'Compressor.Attack': () => pick([1, 3, 5, 10, 20, 30, 50]),
    'EQ Eight.Low': () => int(-9, 9), 'EQ Eight.Mid': () => int(-9, 9), 'EQ Eight.High': () => int(-9, 9),
    'Auto Filter.Freq': () => pick([200, 400, 500, 800, 1000, 1500, 2000, 2500, 3000, 5000, 8000]), 'Auto Filter.Res': () => 10 * int(0, 8),
    'Saturator.Drive': () => int(1, 18), 'Saturator.Output': () => -int(1, 12), 'Utility.Gain': () => int(-12, 12),
  }[`${type}.${label}`];
  return V?.();
}

// ---------- clauses ----------
// Each maker returns { text, calls, keys, kind, ref, value } or null. keys are the session facts the clause touches;
// a trial never touches a fact twice. kind orders clauses: plain edits, then renames, then track structure, then transport.

const call = (name, args) => ({ name, arguments: args });
function makers(R) {
  const { pick, int, chance, pickW, say } = tools(R);
  const free = (ctx, id, f) => !ctx.used.has(`${id}.${f}`) && !ctx.used.has(`${id}.*`);
  const untouched = (ctx, t) => ![...ctx.used].some(k => k.startsWith(`${t.id}.`));
  // Picks the track(s) a clause is about and how the request names them.
  function ref(s, ctx, f, { group = false, test = () => true } = {}) {
    if (group && chance(0.22)) {
      const g = pick(['drums', 'vocals', 'all']), ts = g === 'all' ? s.tracks : s.tracks.filter(t => t.group === g);
      if (ts.length >= 2 && ts.every(t => free(ctx, t.id, f)) && ts.some(test)) return { ts, text: pick(GROUP_TEXT[g]), type: 'group' };
    }
    const cands = s.tracks.filter(t => free(ctx, t.id, f) && test(t));
    if (!cands.length) return null;
    const t = pick(cands), i = s.tracks.indexOf(t), alias = POOL.find(p => p[0] === t.name)?.[4];
    const kind = ctx.precise ? pickW({ number: 1, exact: 1.5 }) : pickW({ name: 6, number: 2.5, exact: 1.5 }); // precise requests use exact names
    if (kind === 'number') return { ts: [t], text: `track ${say(i + 1)}`, type: 'number' };
    return { ts: [t], text: kind === 'name' && alias ? pick(alias) : t.name, type: 'name' };
  }
  const per = (r, fn) => r.ts.map(fn);
  const out = (text, calls, keys, ref, value, kind = 'edit') => ({ text, calls, keys, ref: ref?.type ?? 'global', refText: ref?.text, value, kind });
  const fxText = (type, the = true) => pick((the ? FX_THE : FX_A)[type]);
  const sampleText = n => `the ${n.toLowerCase()}${/loop$/i.test(n) ? '' : ' sample'}`;

  const M = {
    volume(s, ctx) {
      const kind = pickW({ abs: 3, rel: 4, vague: 3, match: 1.2, unity: 0.6 });
      if (kind === 'match') {
        const r = ref(s, ctx, 'vol');
        const other = r && pick(s.tracks.filter(t => t !== r.ts[0] && free(ctx, t.id, 'vol') && free(ctx, t.id, 'name') && Math.abs(t.vol - r.ts[0].vol) >= 2));
        if (!other) return null;
        const b = POOL.find(p => p[0] === other.name)?.[4], bt = b && chance(0.6) ? pick(b) : other.name;
        const text = pick([`match ${r.text} to ${bt}`, `put ${r.text} at the same level as ${bt}`, `make ${r.text} as loud as ${bt}`, `set ${r.text} to the same level as ${bt}`]);
        return out(text, [call('set_volume', { track: r.ts[0].name, db: other.vol })], [`${r.ts[0].id}.vol`, `${other.id}.vol`, `${other.id}.name`], r, 'match');
      }
      if (kind === 'unity') {
        const r = ref(s, ctx, 'vol', { test: t => Math.abs(t.vol) >= 2 });
        if (!r) return null;
        return out(pick([`put ${r.text} back to unity`, `${r.text} to unity`, `reset ${r.text} to 0 dB`, `bring ${r.text} to unity gain`]), [call('set_volume', { track: r.ts[0].name, db: 0 })], [`${r.ts[0].id}.vol`], r, 'unity');
      }
      if (kind === 'abs') {
        const v = int(-24, 0), r = ref(s, ctx, 'vol', { group: true, test: t => Math.abs(t.vol - v) >= 2 });
        if (!r) return null;
        const sv = say(v);
        const text = pick([`set ${r.text} to ${sv} dB`, `bring ${r.text} to ${sv} dB`, `put ${r.text} at ${sv} dB`, `${r.text} to ${sv} dB`, `make ${r.text} ${sv} dB`, `I want ${r.text} at ${sv} dB`]);
        return out(text, per(r, t => call('set_volume', { track: t.name, db: v })), r.ts.map(t => `${t.id}.vol`), r, 'absolute');
      }
      const d = kind === 'vague' ? pick([1, 1, 2, 2, 3, 6]) : int(1, 6), up = chance(0.5), r = ref(s, ctx, 'vol', { group: true, test: t => t.vol + (up ? d : -d) <= 6 && t.vol > -60 });
      if (!r) return null;
      let text;
      if (kind === 'vague') {
        const w = pick(VAGUE[d]), way = d === 6 && chance(0.3);
        text = way ? pick(up ? [`bring ${r.text} way up`, `turn ${r.text} way up`] : [`bring ${r.text} way down`, `pull ${r.text} way down`])
          : pick(up ? [`bring ${r.text} up ${w}`, `turn ${r.text} up ${w}`, `push ${r.text} ${w}`, `make ${r.text} ${w} louder`, `${r.text} needs to come up ${w}`, `raise ${r.text} ${w}`]
            : [`pull ${r.text} down ${w}`, `bring ${r.text} down ${w}`, `make ${r.text} ${w} quieter`, `back ${r.text} off ${w}`, `tuck ${r.text} in ${w}`, `lower ${r.text} ${w}`]);
      } else {
        const n = say(d);
        text = pick(up ? [`turn ${r.text} up ${n} dB`, `bring ${r.text} up ${n} dB`, `push ${r.text} ${n} dB`, `boost ${r.text} by ${n} dB`, `raise ${r.text} ${n} dB`, `${r.text} up ${n} dB`, `give ${r.text} ${n} more dB`]
          : [`turn ${r.text} down ${n} dB`, `pull ${r.text} down ${n} dB`, `drop ${r.text} ${n} dB`, `cut ${r.text} by ${n} dB`, `lower ${r.text} by ${n} dB`, `tuck ${r.text} ${n} dB`, `${r.text} down ${n} dB`]);
      }
      return out(text, per(r, t => call('set_volume', { track: t.name, db: up ? d : -d, relative: true })), r.ts.map(t => `${t.id}.vol`), r, kind === 'vague' ? 'vague' : 'relative');
    },
    pan(s, ctx) {
      const kind = pickW({ num: 4, hard: 1, half: 1, little: 1.2, center: 1.2 }), side = chance(0.5) ? 'left' : 'right', sign = side === 'left' ? -1 : 1;
      const p = { num: sign * 5 * int(1, 9), hard: sign * 50, half: sign * 25, little: sign * 15, center: 0 }[kind];
      const r = ref(s, ctx, 'pan', { test: t => Math.abs(t.pan - p) >= 5 });
      if (!r) return null;
      const a = say(Math.abs(p)), L = side[0].toUpperCase();
      const text = pick({
        num: [`pan ${r.text} ${a}${L}`, `pan ${r.text} ${a} ${side}`, `pan ${r.text} ${side} ${a}`, `put ${r.text} ${a} ${side}`, `${r.text} ${a} ${side}`],
        hard: [`pan ${r.text} hard ${side}`, `put ${r.text} hard ${side}`, `${r.text} all the way ${side}`],
        half: [`pan ${r.text} halfway ${side}`, `put ${r.text} halfway to the ${side}`],
        little: [`pan ${r.text} a little ${side}`, `nudge ${r.text} slightly ${side}`, `move ${r.text} a bit to the ${side}`, `pan ${r.text} slightly ${side}`],
        center: [`center ${r.text}`, `pan ${r.text} to the center`, `put ${r.text} in the middle`, `pan ${r.text} dead center`],
      }[kind]);
      return out(text, [call('set_pan', { track: r.ts[0].name, pan: p })], [`${r.ts[0].id}.pan`], r, kind === 'num' ? 'pan' : `pan ${kind}`);
    },
    toggle(s, ctx) {
      const op = pickW({ mute: 2.5, solo: 1.5, arm: 1.5 }), v = chance(0.6);
      const field = { mute: 'on', solo: 'solo', arm: 'arm' }[op], cur = t => (op === 'mute' ? !t.on : t[field]);
      const r = ref(s, ctx, field, { group: true, test: t => cur(t) !== v });
      if (!r || !r.ts.every(t => cur(t) !== v) || (GROUP_TEXT.all.includes(r.text) && v)) return null; // no "solo everything"
      const x = r.text;
      const text = pick({
        'mute true': [`mute ${x}`, `kill ${x}`, `silence ${x}`, `turn off ${x}`, `deactivate ${x}`],
        'mute false': [`unmute ${x}`, `bring back ${x}`, `turn ${x} back on`, `reactivate ${x}`],
        'solo true': [`solo ${x}`, `isolate ${x}`, `let me hear just ${x}`, `solo up ${x}`],
        'solo false': [`unsolo ${x}`, `take ${x} out of solo`, `clear the solo on ${x}`],
        'arm true': [`arm ${x}`, `record-enable ${x}`, `arm ${x} for recording`, `get ${x} ready to record`],
        'arm false': [`disarm ${x}`, `unarm ${x}`, `take ${x} out of record`],
      }[`${op} ${v}`]);
      const name = { mute: 'set_mute', solo: 'set_solo', arm: 'set_arm' }[op], key = { mute: 'muted', solo: 'soloed', arm: 'armed' }[op];
      return out(text, per(r, t => call(name, { track: t.name, [key]: v })), r.ts.map(t => `${t.id}.${field}`), r, 'toggle');
    },
    send(s, ctx) {
      const L = chance(0.6) ? 'A' : 'B', w = L === 'A' ? 'reverb' : 'delay', fxType = L === 'A' ? 'Reverb' : 'Delay', f = `send.${L}`;
      const kind = pickW({ abs: 2, more: 2, num: 1.5, kill: 1, some: 1.2 });
      const has = t => t.devices.some(d => d.type === fxType), on = t => t.sends[L] > VOL_MIN;
      const test = { abs: () => true, more: on, num: on, kill: on, some: t => !on(t) }[kind];
      const r = ref(s, ctx, f, { group: kind === 'abs' || kind === 'kill', test: t => test(t) && !has(t) });
      if (!r || !r.ts.every(t => test(t) && !has(t))) return null;
      const x = r.text, sendWord = chance(0.4) ? `${w} send` : w;
      if (kind === 'abs') {
        const v = -int(6, 30);
        if (r.ts.some(t => Math.abs(t.sends[L] - v) < 2)) return null;
        const text = pick([`send ${x} to the ${w} at ${say(v)} dB`, `set the ${w} send on ${x} to ${say(v)} dB`, `${w} send on ${x} at ${say(v)} dB`, `set send ${L} on ${x} to ${say(v)} dB`]);
        return out(text, per(r, t => call('set_send', { track: t.name, send: L, db: v })), r.ts.map(t => `${t.id}.${f}`), r, 'absolute');
      }
      if (kind === 'kill') return out(pick([`no ${w} on ${x}`, `kill the ${w} send on ${x}`, `take ${x} out of the ${w}`, `turn the ${w} send on ${x} all the way off`]), per(r, t => call('set_send', { track: t.name, send: L, db: VOL_MIN })), r.ts.map(t => `${t.id}.${f}`), r, 'send off');
      if (kind === 'some') return out(pick([`add some ${w} to ${x}`, `put some ${w} on ${x}`, `give ${x} some ${w}`]), [call('set_send', { track: r.ts[0].name, send: L, db: -15 })], [`${r.ts[0].id}.${f}`], r, 'send some');
      const up = chance(0.55), d = kind === 'more' ? pick([2, 3]) : int(1, 8), t = r.ts[0];
      if (t.sends[L] + (up ? d : -d) > 0) return null;
      const text = kind === 'more' ? pick(up ? (d === 3 ? [`more ${sendWord} on ${x}`, `give ${x} more ${w}`] : [`a bit more ${sendWord} on ${x}`, `a little more ${w} on ${x}`]) : (d === 3 ? [`less ${sendWord} on ${x}`, `less ${w} on ${x}`] : [`a bit less ${w} on ${x}`, `a little less ${sendWord} on ${x}`]))
        : pick(up ? [`turn the ${w} send on ${x} up ${say(d)} dB`, `bring up the ${w} on ${x} by ${say(d)} dB`] : [`pull the ${w} send on ${x} down ${say(d)} dB`, `turn the ${w} on ${x} down ${say(d)} dB`]);
      return out(text, [call('set_send', { track: t.name, send: L, db: up ? d : -d, relative: true })], [`${t.id}.${f}`], r, kind === 'more' ? 'vague' : 'relative');
    },
    returns(s, ctx) {
      const tgt = pick(['A', 'B', 'Main']), key = tgt === 'Main' ? 'main.vol' : `r:${tgt}.vol`;
      if (ctx.used.has(key)) return null;
      const name = tgt === 'Main' ? 'Main' : s.returns.find(r => r.id === tgt).name, cur = tgt === 'Main' ? s.main.vol : s.returns.find(r => r.id === tgt).vol;
      const x = tgt === 'Main' ? pick(['the master', 'the main', 'the master fader', 'the main output']) : pick([`the ${tgt === 'A' ? 'reverb' : 'delay'} return`, `return ${tgt}`, `the ${tgt} return`]);
      if (chance(0.5)) {
        const d = int(1, 6), up = cur + d <= 6 && chance(0.5);
        return out(pick(up ? [`turn ${x} up ${say(d)} dB`, `bring ${x} up ${say(d)} dB`] : [`turn ${x} down ${say(d)} dB`, `pull ${x} down ${say(d)} dB`]), [call('set_volume', { track: name, db: up ? d : -d, relative: true })], [key], null, 'relative');
      }
      const v = -int(0, 12);
      if (Math.abs(v - cur) < 2) return null;
      return out(pick([`set ${x} to ${say(v)} dB`, `put ${x} at ${say(v)} dB`]), [call('set_volume', { track: name, db: v })], [key], null, 'absolute');
    },
    rename(s, ctx) {
      const r = ref(s, ctx, 'name'), n = pick(NEW_NAMES.filter(x => !s.tracks.some(t => t.name.toLowerCase() === x.toLowerCase()) && !ctx.used.has(`name:${x}`)));
      if (!r || !n) return null;
      const text = pick([`rename ${r.text} to ${n}`, `call ${r.text} ${n}`, `name ${r.text} ${n}`, `change the name of ${r.text} to ${n}`]);
      return out(text, [call('rename_track', { track: r.ts[0].name, name: n })], [`${r.ts[0].id}.*`, `name:${n}`], r, 'name', 'rename');
    },
    color(s, ctx) {
      const c = pick(Object.keys(COLORS)), r = ref(s, ctx, 'color', { test: t => t.color !== COLORS[c] });
      if (!r) return null;
      return out(pick([`make ${r.text} ${c}`, `color ${r.text} ${c}`, `turn ${r.text} ${c}`, `change the color of ${r.text} to ${c}`]), [call('set_track_color', { track: r.ts[0].name, color: c })], [`${r.ts[0].id}.color`], r, 'color');
    },
    addEffect(s, ctx) {
      const r = ref(s, ctx, 'fx', { test: t => t.devices.length < 3 });
      if (!r) return null;
      const t = r.ts[0], type = pick(Object.keys(DEVICES).filter(e => !t.devices.some(d => d.type === e)));
      const fx = fxText(type, false);
      return out(pick([`put ${fx} on ${r.text}`, `add ${fx} to ${r.text}`, `throw ${fx} on ${r.text}`, `slap ${fx} on ${r.text}`, `insert ${fx} on ${r.text}`]), [call('add_effect', { track: t.name, effect: type })], [`${t.id}.fx`], r, 'effect');
    },
    removeEffect(s, ctx) {
      // never change an effect and also remove it in the same request
      const r = ref(s, ctx, 'fx', { test: t => t.devices.length > 0 && ![...ctx.used].some(k => k.startsWith(`${t.id}.fx`)) });
      if (!r) return null;
      const t = r.ts[0], d = pick(t.devices), fx = fxText(d.type);
      return out(pick([`take the ${fx} off ${r.text}`, `remove the ${fx} from ${r.text}`, `delete the ${fx} on ${r.text}`, `get rid of the ${fx} on ${r.text}`]), [call('remove_effect', { track: t.name, effect: d.type })], [`${t.id}.fx`], r, 'effect');
    },
    bypass(s, ctx) {
      const r = ref(s, ctx, 'fx', { test: t => t.devices.length > 0 });
      if (!r) return null;
      const t = r.ts[0], d = pick(t.devices), fx = fxText(d.type), v = !d.on;
      const text = pick(v ? [`turn the ${fx} on ${r.text} back on`, `enable the ${fx} on ${r.text}`, `un-bypass the ${fx} on ${r.text}`]
        : [`bypass the ${fx} on ${r.text}`, `turn off the ${fx} on ${r.text}`, `disable the ${fx} on ${r.text}`]);
      return out(text, [call('set_effect_on', { track: t.name, effect: d.type, on: v })], [`${t.id}.fx`], r, 'toggle');
    },
    effectParam(s, ctx) {
      const r = ref(s, ctx, 'fxp', { test: t => t.devices.length > 0 });
      if (!r) return null;
      const t = r.ts[0], d = pick(t.devices), p = pick(DEVICES[d.type].params.filter(x => x.label !== 'Balance')), x = r.text, fx = fxText(d.type);
      const cur = d.params[p.label], key = `${t.id}.fx.${d.type}.${p.label}`;
      if (ctx.used.has(key) || ctx.used.has(`${t.id}.fx`)) return null;
      if (d.type === 'EQ Eight' && chance(0.6)) { // "boost the highs 3 dB"
        const dd = int(1, 6), up = cur + dd <= 15 && (cur - dd < -15 || chance(0.5)), band = pick({ Low: ['lows', 'low end', 'bottom end'], Mid: ['mids'], High: ['highs', 'top end'] }[p.label]);
        const text = pick(up ? [`boost the ${band} on ${x} ${say(dd)} dB`, `add ${say(dd)} dB of ${band} to ${x}`] : [`cut the ${band} on ${x} by ${say(dd)} dB`, `take ${say(dd)} dB of ${band} out of ${x}`]);
        return out(text, [call('set_effect_param', { track: t.name, effect: d.type, param: p.label, value: up ? dd : -dd, relative: true })], [key], r, 'relative');
      }
      const v = randParam(R, d.type, p.label);
      if (v === undefined || Math.abs(v - cur) <= (p.max - p.min) * 0.02) return null;
      const sv = say(v), hz = v >= 1000 && chance(0.5) ? `${v / 1000} kHz` : `${v} Hz`;
      const T = {
        'Reverb.Decay': [`set the reverb decay on ${x} to ${v} seconds`, `make the reverb on ${x} ${v} seconds long`, `reverb decay ${v} s on ${x}`],
        'Reverb.Dry/Wet': [`set the reverb mix on ${x} to ${v} percent`, `reverb dry/wet on ${x} at ${v}%`, `make the reverb on ${x} ${v}% wet`],
        'Delay.Dry/Wet': [`set the delay mix on ${x} to ${v} percent`, `delay dry/wet on ${x} at ${v}%`, `make the delay on ${x} ${v}% wet`],
        'Delay.Time': [`set the delay time on ${x} to ${v} ms`, `make the delay on ${x} ${v} milliseconds`],
        'Delay.Feedback': [`set the delay feedback on ${x} to ${v} percent`, `delay feedback ${v}% on ${x}`],
        'Compressor.Thresh': [`set the compressor threshold on ${x} to ${sv} dB`, `compressor threshold ${sv} dB on ${x}`, `bring the threshold on the ${fx} on ${x} to ${sv} dB`],
        'Compressor.Ratio': [`set the compressor ratio on ${x} to ${v}:1`, `make the compressor on ${x} ${v}:1`, `${v} to 1 ratio on the compressor on ${x}`],
        'Compressor.Attack': [`set the compressor attack on ${x} to ${v} ms`, `${v} ms attack on the compressor on ${x}`],
        'EQ Eight.Low': [`set the EQ low band on ${x} to ${sv} dB`], 'EQ Eight.Mid': [`set the EQ mid band on ${x} to ${sv} dB`], 'EQ Eight.High': [`set the EQ high band on ${x} to ${sv} dB`],
        'Auto Filter.Freq': [`set the filter cutoff on ${x} to ${hz}`, `filter ${x} at ${hz}`, `close the filter on ${x} down to ${hz}`],
        'Auto Filter.Res': [`set the filter resonance on ${x} to ${v} percent`],
        'Saturator.Drive': [`set the saturator drive on ${x} to ${sv} dB`, `drive the saturator on ${x} at ${sv} dB`],
        'Saturator.Output': [`set the saturator output on ${x} to ${sv} dB`],
        'Utility.Gain': [`set the utility gain on ${x} to ${sv} dB`, `utility gain ${sv} dB on ${x}`],
      }[`${d.type}.${p.label}`];
      if (!T) return null;
      return out(pick(T), [call('set_effect_param', { track: t.name, effect: d.type, param: p.label, value: v })], [key], r, 'absolute');
    },
    tempo(s, ctx) {
      if (ctx.used.has('tempo')) return null;
      const kind = pickW({ abs: 3, rel: 3, half: 0.5, double: 0.4 });
      if (kind === 'abs') {
        let t; do t = int(70, 170); while (Math.abs(t - s.tempo) < 2);
        return out(pick([`set the tempo to ${say(t)}`, `tempo ${say(t)} BPM`, `change the tempo to ${say(t)} BPM`, `take it to ${say(t)} BPM`, `make it ${say(t)} BPM`]), [call('set_tempo', { bpm: t })], ['tempo'], null, 'absolute');
      }
      if (kind === 'half' || kind === 'double') {
        const t = kind === 'half' ? s.tempo / 2 : s.tempo * 2;
        return out(pick(kind === 'half' ? ['switch to half time', 'halve the tempo', 'take it to half time'] : ['double the tempo', 'go double time']), [call('set_tempo', { bpm: t })], ['tempo'], null, kind);
      }
      const d = int(2, 10), up = chance(0.5);
      return out(pick(up ? [`speed it up by ${say(d)} BPM`, `bump the tempo up ${say(d)}`, `push the tempo up ${say(d)} BPM`, `make it ${say(d)} BPM faster`]
        : [`slow it down ${say(d)} BPM`, `drop the tempo by ${say(d)}`, `bring the tempo down ${say(d)} BPM`, `make it ${say(d)} BPM slower`]), [call('set_tempo', { bpm: up ? d : -d, relative: true })], ['tempo'], null, 'relative');
    },
    metronome(s, ctx) {
      if (ctx.used.has('metronome')) return null;
      const v = !s.metronome;
      return out(pick(v ? ['turn on the metronome', 'turn the click on', 'give me a click', 'metronome on'] : ['turn off the metronome', 'kill the click', 'metronome off', 'lose the click']), [call('set_metronome', { on: v })], ['metronome'], null, 'toggle');
    },
    loop(s, ctx) {
      if (ctx.used.has('loop')) return null;
      const kind = pickW({ region: 3, off: s.loop.on ? 1 : 0, on: s.loop.on ? 0 : 0.7 });
      if (kind === 'off') return out(pick(['turn the loop off', 'stop looping', 'loop off', 'disable the loop']), [call('set_loop', { on: false })], ['loop'], null, 'toggle');
      if (kind === 'on') return out(pick(['turn the loop back on', 'loop on', 'switch the loop on']), [call('set_loop', { on: true })], ['loop'], null, 'toggle');
      const a = int(1, 24), len = pick([1, 2, 4, 4, 8]), b = a + len - 1;
      if (s.loop.on && s.loop.start === a - 1 && s.loop.end === a - 1 + len) return null;
      const text = len === 1 ? pick([`loop bar ${say(a)}`, `just loop bar ${say(a)}`])
        : pick([`loop bars ${say(a)} to ${say(b)}`, `loop from bar ${say(a)} to bar ${say(b)}`, `set a ${len}-bar loop starting at bar ${say(a)}`, `loop ${say(a)} through ${say(b)}`]);
      return out(text, [call('set_loop', { on: true, start_bar: a, length_bars: len })], ['loop'], null, 'bars');
    },
    transport(s, ctx) {
      if (ctx.used.has('transport')) return null;
      if (s.transport === 'playing') return out(pick(['stop', 'stop playback', 'stop it', 'hold on, stop']), [call('stop', {})], ['transport'], null, 'transport', 'transport');
      const kind = pickW({ play: 1, from: 2, record: s.tracks.some(t => t.arm) ? 1 : 0 });
      if (kind === 'record') return out(pick(['hit record', 'start recording', "let's record"]), [call('record', {})], ['transport'], null, 'transport', 'transport');
      if (kind === 'play') return out(pick(['play', 'hit play', 'start playback', "let's hear it"]), [call('play', {})], ['transport'], null, 'transport', 'transport');
      const b = chance(0.2) ? 1 : int(2, 24);
      const text = b === 1 && chance(0.6) ? 'play it from the top' : pick([`play from bar ${say(b)}`, `play it from bar ${say(b)}`, `start playback at bar ${say(b)}`, `let's hear it from bar ${say(b)}`]);
      return out(text, [call('play', { from_bar: b })], ['transport'], null, 'bars', 'transport');
    },
    insertTrack(s, ctx) {
      if (ctx.used.has('structure')) return null;
      const n = pick(NEW_NAMES.filter(x => !s.tracks.some(t => t.name.toLowerCase() === x.toLowerCase()) && !ctx.used.has(`name:${x}`)));
      const kind = pickW({ plain: 1, named: 2, after: 1 }), r = kind === 'after' ? ref(s, ctx, 'struct') : null;
      if (kind === 'after' && (!r || r.type === 'number')) return null;
      if (kind === 'plain') return out(pick(['add an audio track', 'add a new track', 'insert an audio track', 'make a new audio track']), [call('insert_track', {})], ['structure'], null, 'track', 'structure');
      if (kind === 'named') return out(pick([`add a new track called ${n}`, `create an audio track named ${n}`, `insert a track called ${n}`]), [call('insert_track', { name: n })], ['structure', `name:${n}`], null, 'track', 'structure');
      return out(pick([`add a track called ${n} after ${r.text}`, `insert a new track called ${n} after ${r.text}`]), [call('insert_track', { name: n, after: r.ts[0].name })], ['structure', `name:${n}`, `${r.ts[0].id}.*`], r, 'track', 'structure');
    },
    deleteTrack(s, ctx) {
      if (ctx.used.has('structure') || s.tracks.length < 4) return null;
      const r = ref(s, ctx, 'struct', { test: t => untouched(ctx, t) }); // never edit a track and then delete it
      if (!r) return null;
      const x = r.text, named = r.type !== 'number';
      return out(pick([`delete ${x}`, `remove ${x}`, `get rid of ${x}`, ...(named ? [`delete the ${x.replace(/^the /, '')} track`] : [])]), [call('delete_track', { track: r.ts[0].name })], ['structure', `${r.ts[0].id}.*`], r, 'track', 'structure');
    },
    duplicateTrack(s, ctx) {
      if (ctx.used.has('structure')) return null;
      const r = ref(s, ctx, 'struct');
      if (!r) return null;
      return out(pick([`duplicate ${r.text}`, `make a copy of ${r.text}`, ...(r.type !== 'number' ? [`duplicate the ${r.text.replace(/^the /, '')} track`] : [])]), [call('duplicate_track', { track: r.ts[0].name })], ['structure', `${r.ts[0].id}.*`], r, 'track', 'structure');
    },
    addSample(s, ctx) {
      const r = ref(s, ctx, 'clips');
      if (!r) return null;
      const name = pick(Object.keys(SAMPLES)), b = int(1, 24), len = pick([null, null, 2, 4, 8]), smp = sampleText(name);
      const text = len ? pick([`put ${len} bars of ${smp} on ${r.text} at bar ${say(b)}`, `add ${smp} to ${r.text} at bar ${say(b)} for ${len} bars`])
        : pick([`drop ${smp} on ${r.text} at bar ${say(b)}`, `add ${smp} to ${r.text} starting at bar ${say(b)}`, `stick ${smp} on ${r.text} at bar ${say(b)}`]);
      return out(text, [call('add_sample', { track: r.ts[0].name, sample: name, bar: b, ...(len ? { length_bars: len } : {}) })], [`${r.ts[0].id}.clips`], r, 'bars');
    },
    deleteRange(s, ctx) {
      const a = int(1, 20), b = a + int(0, 7), covers = t => t.clips.some(c => c.start < b && c.start + c.len > a - 1);
      const r = ref(s, ctx, 'clips', { group: true, test: covers });
      if (!r || !r.ts.every(covers)) return null;
      const x = r.text;
      const text = a === b ? pick([`delete bar ${say(a)} on ${x}`, `clear bar ${say(a)} on ${x}`])
        : pick([`delete bars ${say(a)} to ${say(b)} on ${x}`, `clear ${x} from bar ${say(a)} to ${say(b)}`, `remove bars ${say(a)} through ${say(b)} from ${x}`, `delete ${x} between bars ${say(a)} and ${say(b)}`]);
      return out(text, per(r, t => call('delete_range', { track: t.name, from_bar: a, to_bar: b })), r.ts.map(t => `${t.id}.clips`), r, 'bars');
    },
    duplicateRange(s, ctx) {
      const a = int(1, 16), b = a + pick([0, 1, 3, 3, 7]), covers = t => t.clips.some(c => c.start < b && c.start + c.len > a - 1);
      const r = ref(s, ctx, 'clips', { test: covers });
      if (!r) return null;
      const x = r.text;
      const text = a === b ? pick([`duplicate bar ${say(a)} on ${x}`, `repeat bar ${say(a)} on ${x}`])
        : pick([`duplicate bars ${say(a)} to ${say(b)} on ${x}`, `repeat bars ${say(a)}-${say(b)} on ${x}`, `copy bars ${say(a)} to ${say(b)} on ${x} and paste them right after`]);
      return out(text, [call('duplicate_range', { track: r.ts[0].name, from_bar: a, to_bar: b })], [`${r.ts[0].id}.clips`], r, 'bars');
    },
  };

  // Precise requests: exact decimals, exact control and device names, signed pan, explicit lengths -- how an engineer
  // says it when they know exactly what they want. Makers not listed here fall back to the casual ones.
  const dec = (lo, hi, step) => Math.round((lo + Math.floor(R() * (Math.round((hi - lo) / step) + 1)) * step) * 100) / 100;
  const UNIT = { dB: ' dB', s: ' s', ms: ' ms', Hz: ' Hz', '%': '%', ':1': ':1', '': '' };
  const PRECISE_VALUE = {
    Decay: () => dec(0.3, 8, 0.05), 'Dry/Wet': () => int(0, 100), Time: () => int(20, 1000), Feedback: () => int(0, 90), Thresh: () => dec(-40, 0, 0.5),
    Ratio: () => dec(1, 20, 0.5), Attack: () => int(1, 100), Low: () => dec(-15, 15, 0.5), Mid: () => dec(-15, 15, 0.5), High: () => dec(-15, 15, 0.5),
    Freq: () => 10 * int(4, 2000), Res: () => int(0, 100), Drive: () => dec(0, 24, 0.5), Output: () => dec(-24, 0, 0.5), Gain: () => dec(-24, 24, 0.5),
  };
  const PRECISE_STEP = { dB: () => dec(0.5, 6, 0.5), s: () => dec(0.1, 2, 0.05), ms: () => int(5, 200), '%': () => int(1, 30), ':1': () => dec(0.5, 4, 0.5) };
  const restyle = (c, texts, value) => c && Object.assign(c, { text: pick(texts), value });
  const P = {
    volume(s, ctx) {
      if (chance(0.55)) {
        const v = chance(0.5) ? dec(-30, 0, 0.5) : dec(-30, 0, 0.1), r = ref(s, ctx, 'vol', { group: true, test: t => Math.abs(t.vol - v) >= 0.5 });
        if (!r || !r.ts.every(t => Math.abs(t.vol - v) >= 0.5)) return null;
        const X = r.text;
        const T = r.type === 'group' ? [`set the volume of ${X} to ${v} dB`, `set ${X} to exactly ${v} dB`] : [`set ${X} volume to ${v} dB`, `set the volume of ${X} to ${v} dB`, `${X} fader to ${v} dB`, `set ${X} to exactly ${v} dB`];
        return out(pick(T), per(r, t => call('set_volume', { track: t.name, db: v })), r.ts.map(t => `${t.id}.vol`), r, 'precise absolute');
      }
      const d = chance(0.5) ? dec(0.5, 6, 0.5) : dec(0.1, 6, 0.1), up = chance(0.5), r = ref(s, ctx, 'vol', { group: true, test: t => t.vol + (up ? d : -d) <= 6 && t.vol > -60 });
      if (!r || !r.ts.every(t => t.vol + (up ? d : -d) <= 6 && t.vol > -60)) return null;
      const X = r.text;
      const T = r.type === 'group' ? [`${up ? 'increase' : 'decrease'} the volume of ${X} by ${d} dB`] : up ? [`increase ${X} volume by ${d} dB`, `raise the volume of ${X} by ${d} dB`, `${X} volume +${d} dB`] : [`decrease ${X} volume by ${d} dB`, `lower the volume of ${X} by ${d} dB`, `${X} volume -${d} dB`];
      return out(pick(T), per(r, t => call('set_volume', { track: t.name, db: up ? d : -d, relative: true })), r.ts.map(t => `${t.id}.vol`), r, 'precise relative');
    },
    pan(s, ctx) {
      const a = int(1, 50), side = chance(0.5) ? 'left' : 'right', p = (side === 'left' ? -1 : 1) * a, L = side[0].toUpperCase();
      const r = ref(s, ctx, 'pan', { test: t => Math.abs(t.pan - p) >= 2 });
      if (!r) return null;
      const X = r.text;
      return out(pick([`set ${X} pan to ${a}${L}`, `set the pan of ${X} to ${a} ${side}`, `pan ${X} to ${a}${L}`, `set ${X} pan to ${p}`]), [call('set_pan', { track: r.ts[0].name, pan: p })], [`${r.ts[0].id}.pan`], r, 'precise pan');
    },
    send(s, ctx) {
      const L = chance(0.55) ? 'A' : 'B', ret = L === 'A' ? 'A Reverb' : 'B Delay', f = `send.${L}`;
      if (chance(0.65)) {
        const v = chance(0.5) ? dec(-48, 0, 0.5) : dec(-48, 0, 0.1), r = ref(s, ctx, f, { test: t => Math.abs(t.sends[L] - v) >= 0.5 });
        if (!r) return null;
        const X = r.text;
        return out(pick([`set ${X} send ${L} to ${v} dB`, `set send ${L} on ${X} to ${v} dB`, `set the ${ret} send on ${X} to ${v} dB`]), [call('set_send', { track: r.ts[0].name, send: L, db: v })], [`${r.ts[0].id}.${f}`], r, 'precise absolute');
      }
      const d = dec(0.5, 6, 0.5), up = chance(0.5), r = ref(s, ctx, f, { test: t => t.sends[L] > VOL_MIN && t.sends[L] + (up ? d : -d) <= 0 && t.sends[L] - d > -60 });
      if (!r) return null;
      const X = r.text;
      return out(pick(up ? [`increase send ${L} on ${X} by ${d} dB`, `raise the ${ret} send on ${X} by ${d} dB`] : [`decrease send ${L} on ${X} by ${d} dB`, `lower the ${ret} send on ${X} by ${d} dB`]),
        [call('set_send', { track: r.ts[0].name, send: L, db: up ? d : -d, relative: true })], [`${r.ts[0].id}.${f}`], r, 'precise relative');
    },
    returns(s, ctx) {
      const tgt = pick(['A', 'B', 'Main']), isMain = tgt === 'Main', o = isMain ? s.main : s.returns.find(r => r.id === tgt), name = isMain ? 'Main' : o.name;
      if (!isMain && chance(0.35)) {
        const a = int(1, 50), p = (chance(0.5) ? -1 : 1) * a;
        if (ctx.used.has(`r:${tgt}.pan`) || Math.abs(o.pan - p) < 2) return null;
        return out(pick([`set ${name} pan to ${a}${p < 0 ? 'L' : 'R'}`, `pan ${name} to ${p}`]), [call('set_pan', { track: name, pan: p })], [`r:${tgt}.pan`], null, 'precise pan');
      }
      const v = dec(-24, 0, 0.5), key = isMain ? 'main.vol' : `r:${tgt}.vol`;
      if (ctx.used.has(key) || Math.abs(o.vol - v) < 0.5) return null;
      return out(pick([`set ${name} volume to ${v} dB`, `set the ${name} volume to ${v} dB`, `${name} fader to ${v} dB`]), [call('set_volume', { track: name, db: v })], [key], null, 'precise absolute');
    },
    effectParam(s, ctx) {
      const r = ref(s, ctx, 'fxp', { test: t => t.devices.length > 0 });
      if (!r) return null;
      const t = r.ts[0], d = pick(t.devices), p = pick(DEVICES[d.type].params.filter(x => x.label !== 'Balance')), X = r.text, u = UNIT[p.unit];
      const cur = d.params[p.label], key = `${t.id}.fx.${d.type}.${p.label}`;
      if (ctx.used.has(key) || ctx.used.has(`${t.id}.fx`)) return null;
      if (PRECISE_STEP[p.unit] && chance(0.3)) {
        const dd = PRECISE_STEP[p.unit](), up = cur + dd <= p.max && (cur - dd < p.min || chance(0.5));
        if (!up && cur - dd < p.min) return null;
        return out(pick([`${up ? 'increase' : 'decrease'} the ${d.type} ${p.label} on ${X} by ${dd}${u}`, `${up ? 'raise' : 'lower'} ${p.label} on the ${d.type} on ${X} by ${dd}${u}`]),
          [call('set_effect_param', { track: t.name, effect: d.type, param: p.label, value: up ? dd : -dd, relative: true })], [key], r, 'precise relative');
      }
      const v = PRECISE_VALUE[p.label]();
      if (Math.abs(v - cur) <= (p.max - p.min) * 0.01 || (p.log && Math.abs(Math.log(v / cur)) < 0.05)) return null;
      const vt = p.unit === 'Hz' && v >= 1000 && chance(0.4) ? `${v / 1000} kHz` : `${v}${u}`;
      return out(pick([`set ${d.type} ${p.label} on ${X} to ${vt}`, `set the ${p.label} of the ${d.type} on ${X} to ${vt}`, `${X} ${d.type} ${p.label} ${vt}`]),
        [call('set_effect_param', { track: t.name, effect: d.type, param: p.label, value: v })], [key], r, 'precise absolute');
    },
    tempo(s, ctx) {
      if (ctx.used.has('tempo')) return null;
      if (chance(0.6)) {
        const t = chance(0.6) ? dec(60, 180, 0.5) : dec(60, 180, 0.1);
        if (Math.abs(t - s.tempo) < 0.5) return null;
        return out(pick([`set the tempo to ${t} BPM`, `tempo ${t} BPM`, `set BPM to ${t}`]), [call('set_tempo', { bpm: t })], ['tempo'], null, 'precise absolute');
      }
      const d = dec(0.5, 10, 0.5), up = chance(0.5);
      return out(pick([`${up ? 'increase' : 'decrease'} the tempo by ${d} BPM`, `tempo ${up ? '+' : '-'}${d} BPM`]), [call('set_tempo', { bpm: up ? d : -d, relative: true })], ['tempo'], null, 'precise relative');
    },
    loop(s, ctx) {
      if (ctx.used.has('loop')) return null;
      const a = int(1, 32), len = pick([1, 2, 3, 4, 5, 6, 8, 12, 16]), bars = `${len} bar${len > 1 ? 's' : ''}`;
      if (s.loop.on && s.loop.start === a - 1 && s.loop.end === a - 1 + len) return null;
      return out(pick([`set the loop to start at bar ${a} with a length of ${bars}`, `loop ${bars} starting at bar ${a}`, `set loop start to bar ${a} and loop length to ${bars}`]),
        [call('set_loop', { on: true, start_bar: a, length_bars: len })], ['loop'], null, 'precise bars');
    },
    addSample(s, ctx) {
      const r = ref(s, ctx, 'clips');
      if (!r) return null;
      const name = pick(Object.keys(SAMPLES)), b = int(1, 32), len = int(1, 16), bars = `${len} bar${len > 1 ? 's' : ''}`;
      return out(pick([`place ${name} on ${r.text} at bar ${b} for ${bars}`, `add ${name} to ${r.text} at bar ${b}, length ${bars}`]),
        [call('add_sample', { track: r.ts[0].name, sample: name, bar: b, length_bars: len })], [`${r.ts[0].id}.clips`], r, 'precise bars');
    },
    addEffect: (s, ctx) => {
      const c = M.addEffect(s, ctx), e = c?.calls[0].arguments.effect, an = /^[AEIOU]/.test(e ?? '') ? 'an' : 'a';
      return restyle(c, [`add ${e} to ${c?.refText}`, `insert ${e} on ${c?.refText}`, `add ${an} ${e} device to ${c?.refText}`], 'precise effect');
    },
    removeEffect: (s, ctx) => { const c = M.removeEffect(s, ctx), e = c?.calls[0].arguments.effect; return restyle(c, [`remove ${e} from ${c?.refText}`, `delete the ${e} device on ${c?.refText}`], 'precise effect'); },
    bypass: (s, ctx) => {
      const c = M.bypass(s, ctx), a = c?.calls[0].arguments;
      return restyle(c, a?.on ? [`activate the ${a.effect} device on ${c.refText}`, `set ${a.effect} on ${c.refText} to on`] : [`deactivate the ${a?.effect} device on ${c?.refText}`, `set ${a?.effect} on ${c?.refText} to off`], 'precise toggle');
    },
  };
  M.precise = P;
  return M;
}
const WEIGHTS = {
  volume: 5, pan: 3, toggle: 4, send: 2.5, returns: 0.8, rename: 1, color: 0.6, addEffect: 1.3, removeEffect: 0.9, bypass: 0.9, effectParam: 2,
  tempo: 1, metronome: 0.5, loop: 1, transport: 1, insertTrack: 0.8, deleteTrack: 0.6, duplicateTrack: 0.5, addSample: 0.9, deleteRange: 0.9, duplicateRange: 0.7,
};
const RANK = { edit: 0, rename: 1, structure: 2, transport: 3 };

function sentence(R, texts) {
  const { pick, chance } = tools(R);
  const cap = x => x[0].toUpperCase() + x.slice(1);
  let body;
  if (texts.length === 1) body = texts[0];
  else {
    const style = pick(['list', 'list', 'list', 'then', 'sentences', 'also']);
    if (style === 'then') body = texts.join(', then ');
    else if (style === 'sentences') body = texts.map(cap).join('. ');
    else if (style === 'also' && texts.length > 2) body = `${texts.slice(0, -1).join(', ')}. Also ${texts.at(-1)}`;
    else body = `${texts.slice(0, -1).join(', ')} and ${texts.at(-1)}`;
  }
  const verb = /^(set|bring|put|turn|pull|push|pan|mute|solo|arm|unmute|unsolo|disarm|add|delete|remove|duplicate|make|rename|call|loop|play|stop|send|change|center|drop|cut|lower|raise|boost|give|take|insert|create|color|kill|tuck|back|move|nudge|match|increase|decrease|place|activate|deactivate)\b/i.test(body);
  if (chance(0.2)) body = `${pick(verb ? ['can you ', 'could you ', 'please ', 'ok, ', 'alright, ', 'right, '] : ['ok, ', 'alright, ', 'right, '])}${body}`;
  body = cap(body);
  if (chance(0.06)) body += pick([', please', ', thanks']);
  if (chance(0.15)) return body.toLowerCase().replace(/,/g, '').replace(/\.(\s|$)/g, '$1'); // like a speech transcript (keeps decimals)
  return `${body}.`;
}

// One trial with n clauses. layout: 'study' (the 8 study tracks) or 'random' (5-10 tracks from POOL).
export function makeTrial(R, id, n, layout) {
  const mk = makers(R), { pickW } = tools(R);
  for (;;) {
    // register: casual (spoken, vague words) or precise (exact values and names); clauses mostly follow it
    const s = session(R, layout), ctx = { used: new Set() }, clauses = [], register = R() < 0.45 ? 'precise' : 'casual';
    for (let tries = 0; clauses.length < n && tries < 300; tries++) {
      ctx.precise = R() < (register === 'precise' ? 0.85 : 0.12);
      const op = pickW(WEIGHTS), c = (ctx.precise && mk.precise[op] ? mk.precise[op] : mk[op])(s, ctx);
      if (!c || c.keys.some(k => ctx.used.has(k))) continue;
      c.keys.forEach(k => ctx.used.add(k));
      clauses.push(c);
    }
    if (clauses.length < n) continue;
    clauses.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    // every clause must change the session at its place in the order, and nothing may fail
    let cur = s, ok = true;
    for (const c of clauses) {
      const { state, errors } = applyCalls(cur, c.calls);
      if (errors.length || !diff(cur, state).length) { ok = false; break; }
      cur = state;
    }
    if (!ok) continue;
    const gt = clauses.flatMap(c => c.calls), uniq = a => [...new Set(a)].join('|');
    return {
      id, layout, register, n_clauses: n, n_calls: gt.length, instruction: sentence(R, clauses.map(c => c.text)),
      tools: uniq(gt.map(c => c.name)), ref_types: uniq(clauses.map(c => c.ref)), value_types: uniq(clauses.map(c => c.value)),
      initial: s, gt, target: cur,
    };
  }
}

// ---------- hard trials (study set only; nothing like them is in the training data) ----------
// Requests that need more than reading names and numbers off the session: tracks described instead of named, values
// relative to another track, producer slang the model was not taught, tracks that share a name, clauses that refer to
// the result of an earlier clause, and long batches. Each still has exactly one correct result.
export const CHALLENGES = ['described track', 'relative to another track', 'unseen slang', 'same-name tracks', 'refers to earlier clause', 'long batch'];
const DRUMS = t => t.group === 'drums';

function hardMakers(R) {
  const { pick, int, chance, shuffle } = tools(R);
  const alias = t => pick(POOL.find(p => p[0] === t.name)?.[4] ?? [t.name]);
  const labelOf = (s, t) => { const same = s.tracks.filter(x => x.name === t.name); return same.length > 1 ? `${t.name} #${same.indexOf(t) + 1}` : t.name; };
  const clause = (text, calls, keys, kind = 'edit') => ({ text, calls, keys, kind });
  const vol = t => (t.vol <= VOL_MIN ? VOL_MIN : t.vol);
  // An edit on a track the request describes (x) rather than names; name: the label the tool call uses.
  function editOn(s, t, x, { allowDelete = true } = {}) {
    const name = labelOf(s, t), ops = [];
    if (t.vol - 3 > -60) ops.push(() => clause(pick([`turn ${x} down 3 dB`, `pull ${x} down 3 dB`]), [call('set_volume', { track: name, db: -3, relative: true })], [`${t.id}.*`]));
    if (t.vol + 2 <= 6) ops.push(() => clause(pick([`bring ${x} up a bit`, `push ${x} up 2 dB`]), [call('set_volume', { track: name, db: 2, relative: true })], [`${t.id}.*`]));
    const v = pick([-6, -10, -12, -15, -20]);
    if (Math.abs(t.vol - v) >= 2) ops.push(() => clause(`set ${x} to ${v} dB`, [call('set_volume', { track: name, db: v })], [`${t.id}.*`]));
    const p = pick([-40, -30, -20, 20, 30, 40]);
    if (Math.abs(t.pan - p) >= 5) ops.push(() => clause(`pan ${x} ${Math.abs(p)} ${p < 0 ? 'left' : 'right'}`, [call('set_pan', { track: name, pan: p })], [`${t.id}.*`]));
    ops.push(() => clause(t.on ? pick([`mute ${x}`, `kill ${x}`]) : `unmute ${x}`, [call('set_mute', { track: name, muted: t.on })], [`${t.id}.*`]));
    if (!t.solo) ops.push(() => clause(`solo ${x}`, [call('set_solo', { track: name, soloed: true })], [`${t.id}.*`]));
    const fx = ['Compressor', 'Reverb', 'Delay', 'EQ Eight'].find(e => !t.devices.some(d => d.type === e));
    if (fx && t.devices.length < 3) ops.push(() => clause(`put ${pick(FX_A[fx])} on ${x}`, [call('add_effect', { track: name, effect: fx })], [`${t.id}.*`]));
    if (allowDelete && s.tracks.length > 4) ops.push(() => clause(pick([`delete ${x}`, `get rid of ${x}`]), [call('delete_track', { track: name })], [`${t.id}.*`, 'structure'], 'structure'));
    return pick(ops)();
  }
  const ensureDevice = (t, type) => t.devices.find(d => d.type === type) ?? (t.devices.push({ id: `hd${t.id}${type.length}`, type, on: true, params: deviceDefaults(type) }), t.devices.at(-1));

  return {
    'described track'(s) {
      const kind = pick(['highest', 'lowest', 'highestDrum', 'empty', 'onlyMuted', 'onlyFx', 'last', 'after']);
      let t, x;
      const unique = (ts, f, want) => { const sorted = [...ts].sort((a, b) => want * (f(b) - f(a))); return sorted.length > 1 && Math.abs(f(sorted[0]) - f(sorted[1])) >= 1 ? sorted[0] : null; };
      if (kind === 'highest' || kind === 'lowest') {
        t = unique(s.tracks, vol, kind === 'highest' ? 1 : -1);
        x = kind === 'highest' ? pick(['the track with the highest fader', 'whichever track has the highest fader', 'the track whose fader is highest']) : pick(['the track with the lowest fader', 'whichever track has the lowest fader']);
      } else if (kind === 'highestDrum') {
        t = unique(s.tracks.filter(DRUMS), vol, 1); x = pick(['the drum track with the highest fader', 'whichever drum track has the highest fader']);
      } else if (kind === 'empty') {
        t = pick(s.tracks); t.clips = []; x = pick(['the track with no audio on it', 'the empty track', 'the track that has no clips']);
      } else if (kind === 'onlyMuted') {
        t = pick(s.tracks); s.tracks.forEach(o => (o.on = o !== t)); x = pick(['the muted track', 'the track that is muted']);
      } else if (kind === 'onlyFx') {
        const type = pick(['Compressor', 'Saturator', 'Auto Filter', 'Delay']);
        t = pick(s.tracks); s.tracks.forEach(o => (o.devices = o.devices.filter(d => d.type !== type)));
        if (t.devices.length > 2) t.devices.pop();
        ensureDevice(t, type); x = pick([`the track with the ${type} on it`, `the one track that has a ${type}`]);
      } else if (kind === 'last') {
        t = s.tracks.at(-1); x = pick(['the last track', 'the bottom track']);
      } else {
        const i = int(0, s.tracks.length - 2); t = s.tracks[i + 1]; x = pick([`the track right after ${alias(s.tracks[i])}`, `the track below ${alias(s.tracks[i])}`]);
      }
      if (!t) return null;
      return editOn(s, t, x, { allowDelete: !['highest', 'lowest', 'highestDrum'].includes(kind) });
    },
    'relative to another track'(s) {
      const [a, b] = shuffle([...s.tracks]), kind = pick(['quieter', 'louder', 'send', 'mirror', 'swap', 'tempo', 'drumsToKick']);
      if (kind === 'quieter' || kind === 'louder') {
        const d = int(2, 6), v = Math.round((vol(b) + (kind === 'louder' ? d : -d)) * 10) / 10;
        if (v > 6 || v < -60 || Math.abs(v - a.vol) < 1) return null;
        return clause(pick([`make ${alias(a)} ${d} dB ${kind} than ${alias(b)}`, `set ${alias(a)} ${d} dB ${kind === 'louder' ? 'above' : 'below'} ${alias(b)}`]), [call('set_volume', { track: a.name, db: v })], [`${a.id}.*`, `${b.id}.*`]);
      }
      if (kind === 'send') {
        const L = pick(['A', 'B']), w = L === 'A' ? 'reverb' : 'delay';
        if (b.sends[L] <= VOL_MIN || Math.abs(a.sends[L] - b.sends[L]) < 1) return null;
        return clause(pick([`give ${alias(a)} the same ${w} send as ${alias(b)}`, `match the ${w} send on ${alias(a)} to ${alias(b)}`]), [call('set_send', { track: a.name, send: L, db: b.sends[L] })], [`${a.id}.*`, `${b.id}.*`]);
      }
      if (kind === 'mirror') {
        if (b.pan === 0 || Math.abs(a.pan + b.pan) < 5) return null;
        return clause(pick([`pan ${alias(a)} opposite ${alias(b)}`, `mirror the pan of ${alias(b)} on ${alias(a)}`, `put ${alias(a)} on the other side from ${alias(b)}, same amount`]), [call('set_pan', { track: a.name, pan: -b.pan })], [`${a.id}.*`, `${b.id}.*`]);
      }
      if (kind === 'swap') {
        if (Math.abs(a.pan - b.pan) < 5) return null;
        return clause(pick([`swap the pans of ${alias(a)} and ${alias(b)}`, `switch the pan positions of ${alias(a)} and ${alias(b)}`]), [call('set_pan', { track: a.name, pan: b.pan }), call('set_pan', { track: b.name, pan: a.pan })], [`${a.id}.*`, `${b.id}.*`]);
      }
      if (kind === 'drumsToKick') {
        const k = s.tracks.find(t => t.name === 'Kick'), others = s.tracks.filter(t => DRUMS(t) && t !== k && Math.abs(t.vol - k.vol) >= 1);
        if (!k || !others.length) return null;
        return clause(pick(['set the other drum tracks to the same level as the kick', 'match every other drum track to the kick']), others.map(t => call('set_volume', { track: t.name, db: vol(k) })), [k, ...others].map(t => `${t.id}.*`));
      }
      const pct = pick([5, 10, 20, 25, 50]), up = chance(0.5), bpm = Math.round(s.tempo * (1 + (up ? pct : -pct) / 100) * 100) / 100;
      return clause(pick([`make the tempo ${pct} percent ${up ? 'faster' : 'slower'}`, `${up ? 'speed up' : 'slow down'} the tempo by ${pct}%`]), [call('set_tempo', { bpm })], ['tempo']);
    },
    'unseen slang'(s) {
      const t = pick(s.tracks), x = alias(t), d = int(2, 5), kind = pick(['bright', 'dark', 'weight', 'thin', 'scoop', 'sitBack', 'forward', 'dry', 'dropOut', 'backIn', 'middle', 'leftOnly', 'warm', 'glue', 'bypassAll']);
      const eq = band => { const e = ensureDevice(t, 'EQ Eight'); return e.params[band]; };
      const band = (b, sign, texts) => { const cur = eq(b); return cur + sign * d > 15 || cur + sign * d < -15 ? null : clause(pick(texts), [call('set_effect_param', { track: t.name, effect: 'EQ Eight', param: b, value: sign * d, relative: true })], [`${t.id}.*`]); };
      switch (kind) {
        case 'bright': return band('High', 1, [`make ${x} ${d} dB brighter`, `add ${d} dB of air to ${x}`, `open up the top of ${x} by ${d} dB`]);
        case 'dark': return band('High', -1, [`darken ${x} by ${d} dB`, `take ${d} dB of fizz off ${x}`, `make ${x} ${d} dB duller`]);
        case 'weight': return band('Low', 1, [`give ${x} ${d} dB more weight down low`, `fatten up the bottom of ${x} by ${d} dB`]);
        case 'thin': return band('Low', -1, [`thin out the low end of ${x} by ${d} dB`, `clean up ${d} dB of mud from the bottom of ${x}`]);
        case 'scoop': return band('Mid', -1, [`scoop ${d} dB out of the middle of ${x}`, `carve ${d} dB out of the mids on ${x}`]);
        case 'sitBack': return t.vol - d < -60 ? null : clause(pick([`sit ${x} back ${d} dB in the mix`, `push ${x} ${d} dB further back`]), [call('set_volume', { track: t.name, db: -d, relative: true })], [`${t.id}.*`]);
        case 'forward': return t.vol + d > 6 ? null : clause(pick([`bring ${x} ${d} dB more forward in the mix`, `make ${x} sit ${d} dB more up front`]), [call('set_volume', { track: t.name, db: d, relative: true })], [`${t.id}.*`]);
        case 'dry': {
          const on = ['A', 'B'].filter(L => t.sends[L] > VOL_MIN);
          return on.length ? clause(pick([`dry up ${x} completely`, `make ${x} totally dry, no reverb or delay`]), on.map(L => call('set_send', { track: t.name, send: L, db: VOL_MIN })), [`${t.id}.*`]) : null;
        }
        case 'dropOut': return t.on ? clause(pick([`drop ${x} out of the mix`, `take ${x} out of the mix`]), [call('set_mute', { track: t.name, muted: true })], [`${t.id}.*`]) : null;
        case 'backIn': return !t.on ? clause(pick([`bring ${x} back into the mix`, `put ${x} back in`]), [call('set_mute', { track: t.name, muted: false })], [`${t.id}.*`]) : null;
        case 'middle': return t.pan !== 0 ? clause(pick([`put ${x} right down the middle`, `${x} should be dead mono-center`]), [call('set_pan', { track: t.name, pan: 0 })], [`${t.id}.*`]) : null;
        case 'leftOnly': return t.pan !== -50 ? clause(pick([`put ${x} only in the left speaker`, `${x} should come out of the left side only`]), [call('set_pan', { track: t.name, pan: -50 })], [`${t.id}.*`]) : null;
        case 'warm': return t.devices.some(d2 => d2.type === 'Saturator') || t.devices.length > 2 ? null : clause(pick([`warm up ${x} with some drive`, `dirty up ${x} a little with some saturation`]), [call('add_effect', { track: t.name, effect: 'Saturator' })], [`${t.id}.*`]);
        case 'glue': return t.devices.some(d2 => d2.type === 'Compressor') || t.devices.length > 2 ? null : clause(pick([`glue ${x} together with some compression`, `squash ${x} a bit, put some compression on it`]), [call('add_effect', { track: t.name, effect: 'Compressor' })], [`${t.id}.*`]);
        default: {
          const on = t.devices.filter(d2 => d2.on);
          return on.length >= 2 ? clause(pick([`bypass everything on ${x}`, `switch off all the plugins on ${x}`]), on.map(d2 => call('set_effect_on', { track: t.name, effect: d2.type, on: false })), [`${t.id}.*`]) : null;
        }
      }
    },
    'same-name tracks'(s) {
      const t = pick(s.tracks.filter(o => o.clips.length)), empty = chance(0.5);
      if (!t) return null;
      const copy = { ...clone(t), id: `T${s.tracks.length + 1}` };
      if (empty) copy.clips = []; else copy.vol = t.vol + pick([-6, -4, 4, 6]) <= 6 ? t.vol + pick([-6, -4]) : t.vol - 5;
      s.tracks.splice(s.tracks.indexOf(t) + (chance(0.5) ? 1 : 0), 0, copy); // the copy sits just before or after the original
      const [one, two] = s.tracks.filter(o => o.name === t.name), n = t.name.toLowerCase();
      let target, x;
      if (empty) { const e = one.clips.length ? two : one, full = e === one ? two : one; [target, x] = chance(0.5) ? [e, pick([`the ${n} track with no audio`, `the empty ${n} track`, `the ${n} track that has no clips`])] : [full, pick([`the ${n} track with audio on it`, `the ${n} track that has clips`, `the ${n} track that isn't empty`])]; }
      else { const loud = one.vol > two.vol ? one : two; [target, x] = chance(0.5) ? [loud, pick([`the louder ${n} track`, `the ${n} track with the higher fader`])] : [loud === one ? two : one, pick([`the quieter ${n} track`, `the ${n} track with the lower fader`])]; }
      const c = editOn(s, target, x);
      c.keys.push(`${one.id}.*`, `${two.id}.*`);
      return c;
    },
    'refers to earlier clause'(s) {
      const t = pick(s.tracks), x = alias(t), N = pick(NEW_NAMES.filter(n => !s.tracks.some(o => o.name.toLowerCase() === n.toLowerCase()))), kind = pick(['insertPan', 'insertSample', 'dupMute', 'dupPan', 'renameVol', 'compThresh', 'reverbDecay']);
      const p = pick([-40, -25, 25, 40]), side = `${Math.abs(p)} ${p < 0 ? 'left' : 'right'}`;
      switch (kind) {
        case 'insertPan': return clause(pick([`add a track called ${N} and pan it ${side}`, `create a new track named ${N}, then pan it ${side}`]), [call('insert_track', { name: N }), call('set_pan', { track: N, pan: p })], ['structure', `name:${N}`], 'structure');
        case 'insertSample': {
          const smp = pick(Object.keys(SAMPLES)), b = int(1, 16);
          return clause(pick([`make a new track called ${N} and put ${sampleWord(smp)} on it at bar ${b}`, `insert a track named ${N} and drop ${sampleWord(smp)} on it starting at bar ${b}`]), [call('insert_track', { name: N }), call('add_sample', { track: N, sample: smp, bar: b })], ['structure', `name:${N}`], 'structure');
        }
        case 'dupMute': return t.on ? clause(pick([`duplicate ${x} and mute the copy`, `make a copy of ${x} and mute the new one`]), [call('duplicate_track', { track: t.name }), call('set_mute', { track: `${t.name} #2`, muted: true })], ['structure', `${t.id}.*`], 'structure') : null;
        case 'dupPan': return Math.abs(t.pan - p) < 5 ? null : clause(pick([`duplicate ${x} and pan the copy ${side}`, `copy ${x} and put the duplicate ${side}`]), [call('duplicate_track', { track: t.name }), call('set_pan', { track: `${t.name} #2`, pan: p })], ['structure', `${t.id}.*`], 'structure');
        case 'renameVol': {
          const d = int(2, 5);
          return t.vol - d < -60 ? null : clause(pick([`rename ${x} to ${N} and then turn ${N} down ${d} dB`, `call ${x} ${N} from now on, and pull ${N} down ${d} dB`]), [call('rename_track', { track: t.name, name: N }), call('set_volume', { track: N, db: -d, relative: true })], [`${t.id}.*`, `name:${N}`], 'rename');
        }
        case 'compThresh': {
          if (t.devices.some(d => d.type === 'Compressor') || t.devices.length > 2) return null;
          const v = -int(12, 30);
          return clause(pick([`put a compressor on ${x} and set its threshold to ${v} dB`, `add a compressor to ${x}, threshold at ${v} dB`]), [call('add_effect', { track: t.name, effect: 'Compressor' }), call('set_effect_param', { track: t.name, effect: 'Compressor', param: 'Thresh', value: v })], [`${t.id}.*`]);
        }
        default: {
          if (t.devices.some(d => d.type === 'Reverb') || t.devices.length > 2) return null;
          const v = pick([1, 1.5, 3, 4, 5, 6]);
          return clause(pick([`add a reverb to ${x} and make it ${v} seconds long`, `put a reverb on ${x} with a ${v} second decay`]), [call('add_effect', { track: t.name, effect: 'Reverb' }), call('set_effect_param', { track: t.name, effect: 'Reverb', param: 'Decay', value: v })], [`${t.id}.*`]);
        }
      }
    },
  };
}
const sampleWord = n => `the ${n.toLowerCase()}${/loop$/i.test(n) ? '' : ' sample'}`;

// One hard trial: the challenge clause, plus (for some kinds) one or two ordinary clauses so it reads like a real batch.
export function makeHardTrial(R, id, challenge) {
  const { int, chance } = tools(R);
  if (challenge === 'long batch') return { ...makeTrial(R, id, int(8, 10), 'study'), id, set: 'hard', challenge };
  const hm = hardMakers(R), mk = makers(R), { pickW } = tools(R);
  for (;;) {
    const s = session(R, 'study'), h = hm[challenge](s);
    if (!h) continue;
    const ctx = { used: new Set(h.keys) }, extra = [];
    // described tracks and comparisons depend on the session as it was, so they stand alone
    const nExtra = ['described track', 'relative to another track'].includes(challenge) ? 0 : chance(0.5) ? int(1, 2) : 0;
    for (let tries = 0; extra.length < nExtra && tries < 200; tries++) {
      ctx.precise = false;
      const op = pickW(WEIGHTS), c = mk[op](s, ctx);
      if (!c || c.keys.some(k => ctx.used.has(k)) || c.ref === 'number') continue; // numbers shift when tracks are added
      c.keys.forEach(k => ctx.used.add(k));
      extra.push(c);
    }
    if (extra.length < nExtra) continue;
    const clauses = [h, ...extra].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    let cur = s, ok = true;
    for (const c of clauses) {
      const { state, errors } = applyCalls(cur, c.calls);
      if (errors.length || !diff(cur, state).length) { ok = false; break; }
      cur = state;
    }
    if (!ok) continue;
    const gt = clauses.flatMap(c => c.calls), uniq = a => [...new Set(a)].join('|');
    return {
      id, layout: 'study', register: 'casual', n_clauses: clauses.length, n_calls: gt.length, instruction: sentence(R, clauses.map(c => c.text)),
      tools: uniq(gt.map(c => c.name)), ref_types: uniq(clauses.map(c => c.ref ?? 'described')), value_types: uniq(clauses.map(c => c.value ?? challenge)),
      initial: s, gt, target: cur, set: 'hard', challenge,
    };
  }
}
export function generateHard(perChallenge = 14, seed = 4242) {
  const R = rng(seed);
  return CHALLENGES.flatMap(c => Array.from({ length: perChallenge }, () => c)).map((c, i) => makeHardTrial(R, `H${String(i + 1).padStart(3, '0')}`, c));
}

// The study set: n trials split evenly over 1, 3 and 6 clauses, on the 8-track study session.
export function generateStudy(n = 200, seed = 2026) {
  const R = rng(seed), sizes = Array.from({ length: n }, (_, i) => [1, 3, 6][i % 3]);
  for (let i = sizes.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [sizes[i], sizes[j]] = [sizes[j], sizes[i]]; }
  return sizes.map((size, i) => makeTrial(R, `T${String(i + 1).padStart(3, '0')}`, size, 'study'));
}
// Training/validation trials: 1-6 clauses, half on the study layout and half on random sessions.
// `exclude` holds instruction+session keys (e.g. of the study set) that must not appear.
export const trialKey = t => `${t.instruction.toLowerCase()}|${JSON.stringify(t.initial)}`;
export function generateTraining(n, seed, prefix, exclude = new Set()) {
  const R = rng(seed), out = [], seen = new Set(exclude);
  while (out.length < n) {
    const t = makeTrial(R, `${prefix}${String(out.length + 1).padStart(5, '0')}`, 1 + Math.floor(R() * 6), R() < 0.5 ? 'study' : 'random');
    const k = trialKey(t);
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
}
