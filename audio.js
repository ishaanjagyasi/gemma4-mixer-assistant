// Web Audio engine: synthesised parts for the demo clips and browser samples, Live-style audio effects,
// return tracks with sends, arrangement playback (loop, metronome), sample preview and post-fader meter levels.
import { VOL_MIN } from './core.js';
export { DEVICES, SAMPLES, deviceDefaults, fmtParam } from './catalog.js';

// Step patterns (16ths in a bar) and decay in steps; also used to draw the clip waveforms.
const ALL = [...Array(16).keys()], EVEN = ALL.filter(s => s % 2 === 0);
export const SOUNDS = {
  kick: { steps: [0, 4, 8, 12], decay: 1.2 }, snare: { steps: [4, 12], decay: 1 }, clap: { steps: [4, 12], decay: 0.8 },
  hats: { steps: EVEN, decay: 0.4 }, shaker: { steps: ALL, decay: 0.3 }, perc: { steps: [3, 7, 10, 14], decay: 0.8 },
  bass: { steps: [0, 3, 6, 8, 11, 14], decay: 2 }, sub: { steps: [0, 8], decay: 6 },
  keys: { steps: [2, 6, 10, 14], decay: 1.5 }, arp: { steps: EVEN, decay: 0.8 }, pad: { steps: [0], decay: 40 },
  lead: { steps: [0, 3, 6, 10, 12], decay: 3 }, choir: { steps: [0, 8], decay: 10 },
};
const CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]; // Am F C G
const ROOTS = [45, 41, 48, 43];
const _ = null;
const MELODY = [
  [76, _, _, 74, _, _, 72, _, _, _, 71, _, 72, _, _, _], [72, _, _, 72, _, _, 69, _, _, _, 72, _, 74, _, _, _],
  [76, _, _, 79, _, _, 76, _, _, _, 74, _, 72, _, _, _], [74, _, _, 71, _, _, 67, _, _, _, 71, _, 74, _, _, _],
];
const mtof = m => 440 * 2 ** ((m - 69) / 12);
export const dbGain = v => (v <= VOL_MIN ? 0 : 10 ** (v / 20));

export function createEngine({ getState, getTransport }) {
  let ctx = null, mainGain, mainAn, noise, timer = null, playing = false;
  let next = 0, nextPos = 0, last = 0, marks = [];
  const chans = new Map(); // track or return id -> channel
  const buf = new Float32Array(512);

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    mainGain = ctx.createGain();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
    mainAn = ctx.createAnalyser(); mainAn.fftSize = 512;
    mainGain.connect(lim).connect(mainAn).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  // ---------- devices ----------
  function makeDevice(type) {
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; return n; };
    if (type === 'EQ Eight') {
      const lo = bq('lowshelf', 200), mid = bq('peaking', 1000), hi = bq('highshelf', 5000);
      lo.connect(mid).connect(hi);
      return { input: lo, output: hi, set: p => { lo.gain.value = p.Low; mid.gain.value = p.Mid; hi.gain.value = p.High; } };
    }
    if (type === 'Auto Filter') {
      const f = bq('lowpass', 20000);
      return { input: f, output: f, set: p => { f.frequency.value = p.Freq; f.Q.value = 0.7 + (p.Res / 100) * 15; } };
    }
    if (type === 'Compressor') {
      const c = ctx.createDynamicsCompressor();
      return { input: c, output: c, set: p => { c.threshold.value = p.Thresh; c.ratio.value = p.Ratio; c.attack.value = p.Attack / 1000; } };
    }
    if (type === 'Saturator') {
      const pre = g(), sh = ctx.createWaveShaper(), out = g(), curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(3 * x) / Math.tanh(3); }
      sh.curve = curve; pre.connect(sh).connect(out);
      return { input: pre, output: out, set: p => { pre.gain.value = dbGain(p.Drive); out.gain.value = dbGain(p.Output); } };
    }
    if (type === 'Delay') {
      const input = g(), out = g(), dry = g(), wet = g(), dl = ctx.createDelay(2), fb = g();
      input.connect(dry).connect(out); input.connect(dl).connect(wet).connect(out); dl.connect(fb).connect(dl);
      return { input, output: out, set: p => { dl.delayTime.value = p.Time / 1000; fb.gain.value = p.Feedback / 100; wet.gain.value = p['Dry/Wet'] / 100; dry.gain.value = 1 - p['Dry/Wet'] / 100; } };
    }
    if (type === 'Reverb') {
      const input = g(), out = g(), dry = g(), wet = g(), cv = ctx.createConvolver();
      input.connect(dry).connect(out); input.connect(cv).connect(wet).connect(out);
      let decay = 0;
      return { input, output: out, set: p => {
        if (Math.abs(p.Decay - decay) > 0.05) { decay = p.Decay; cv.buffer = impulse(decay); }
        wet.gain.value = p['Dry/Wet'] / 100; dry.gain.value = 1 - p['Dry/Wet'] / 100;
      } };
    }
    const gain = g(), pan = ctx.createStereoPanner(); // Utility
    gain.connect(pan);
    return { input: gain, output: pan, set: p => { gain.gain.value = dbGain(p.Gain); pan.pan.value = p.Balance / 50; } };
  }
  function impulse(sec) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / len); }
    return b;
  }

  // ---------- channels: bus (voices) -> input -> devices -> fader -> pan -> meter -> main; sends tap after the fader ----------
  function channel(id) {
    let c = chans.get(id);
    if (c) return c;
    c = { bus: ctx.createGain(), input: ctx.createGain(), fader: ctx.createGain(), panner: ctx.createStereoPanner(), an: ctx.createAnalyser(), devs: new Map(), sends: new Map(), sig: null };
    c.an.fftSize = 512;
    c.bus.connect(c.input); c.input.connect(c.fader); c.fader.connect(c.panner).connect(c.an).connect(mainGain);
    chans.set(id, c);
    return c;
  }
  function rewire(c, t) {
    c.input.disconnect();
    for (const d of c.devs.values()) d.output.disconnect();
    for (const id of [...c.devs.keys()]) if (!t.devices.some(d => d.id === id)) c.devs.delete(id);
    let node = c.input;
    for (const d of t.devices) {
      if (!c.devs.has(d.id)) c.devs.set(d.id, makeDevice(d.type));
      if (!d.on) continue;
      const dev = c.devs.get(d.id);
      node.connect(dev.input); node = dev.output;
    }
    node.connect(c.fader);
  }
  function strip(t, audible, now) {
    const c = channel(t.id), sig = t.devices.map(d => `${d.id}:${d.on}`).join();
    if (sig !== c.sig) { rewire(c, t); c.sig = sig; }
    for (const d of t.devices) c.devs.get(d.id).set(d.params);
    c.fader.gain.setTargetAtTime(audible ? dbGain(t.vol) : 0, now, 0.015);
    c.panner.pan.setTargetAtTime(t.pan / 50, now, 0.015);
    return c;
  }
  function sync() {
    if (!ctx) return;
    const S = getState(), now = ctx.currentTime, ids = new Set([...S.tracks, ...S.returns].map(t => t.id));
    for (const [id, c] of chans) if (!ids.has(id)) { c.fader.disconnect(); c.an.disconnect(); chans.delete(id); }
    const retSolo = S.returns.some(r => r.solo), trkSolo = S.tracks.some(t => t.solo);
    for (const r of S.returns) strip(r, r.on && (!retSolo || r.solo), now);
    for (const t of S.tracks) {
      const c = strip(t, t.on && (!trkSolo || t.solo), now);
      for (const r of S.returns) {
        let g = c.sends.get(r.id);
        if (!g) { g = ctx.createGain(); g.gain.value = 0; c.fader.connect(g); g.connect(channel(r.id).input); c.sends.set(r.id, g); }
        g.gain.setTargetAtTime(dbGain(t.sends?.[r.id] ?? VOL_MIN), now, 0.015);
      }
    }
    mainGain.gain.setTargetAtTime(dbGain(S.main.vol), now, 0.015);
  }

  // ---------- voices ----------
  const env = (t, a, peak, d, dest) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(dest); return g;
  };
  const osc = (type, f, t, end, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); o.start(t); o.stop(end); return o; };
  const noiseSrc = (t, end, dest) => { const s = ctx.createBufferSource(); s.buffer = noise; s.connect(dest); s.start(t); s.stop(end); };
  const filt = (type, f, dest, q = 1) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.connect(dest); return n; };
  const VOICES = {
    kick(d, t) { const o = osc('sine', 150, t, t + 0.4, env(t, 0.002, 1, 0.35, d)); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); },
    snare(d, t) { noiseSrc(t, t + 0.2, filt('highpass', 1200, env(t, 0.001, 0.5, 0.16, d))); osc('triangle', 185, t, t + 0.12, env(t, 0.001, 0.35, 0.08, d)); },
    clap(d, t) { for (const o of [0, 0.012, 0.024]) noiseSrc(t + o, t + o + 0.2, filt('bandpass', 1500, env(t + o, 0.001, 0.45, o === 0.024 ? 0.15 : 0.01, d))); },
    hats(d, t, st) { noiseSrc(t, t + 0.06, filt('highpass', 8000, env(t, 0.001, st % 4 === 2 ? 0.2 : 0.12, 0.04, d))); },
    shaker(d, t, st) { noiseSrc(t, t + 0.08, filt('highpass', 6000, env(t, 0.006, st % 2 ? 0.05 : 0.09, 0.05, d))); },
    perc(d, t) { const o = osc('sine', 260, t, t + 0.2, env(t, 0.001, 0.5, 0.15, d)); o.frequency.exponentialRampToValueAtTime(180, t + 0.08); },
    bass(d, t, st, bar, step) { osc('sawtooth', mtof(ROOTS[bar % 4]), t, t + step * 2, filt('lowpass', 500, env(t, 0.005, 0.45, step * 1.8, d), 2)); },
    sub(d, t, st, bar, step) { osc('sine', mtof(ROOTS[bar % 4]), t, t + step * 8, env(t, 0.01, 0.6, step * 7.5, d)); },
    keys(d, t, st, bar) { for (const n of CHORDS[bar % 4]) osc('triangle', mtof(n + 12), t, t + 0.4, env(t, 0.003, 0.09, 0.35, d)); },
    arp(d, t, st, bar) { osc('sawtooth', mtof(CHORDS[bar % 4][(st / 2) % 3] + 12), t, t + 0.25, filt('lowpass', 1800, env(t, 0.002, 0.08, 0.18, d))); },
    pad(d, t, st, bar, step) {
      const len = step * 16, g = ctx.createGain(), f = filt('lowpass', 1400, g);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.035, t + 0.4); g.gain.setValueAtTime(0.035, t + len - 0.2); g.gain.linearRampToValueAtTime(0, t + len + 0.4);
      g.connect(d);
      for (const n of CHORDS[bar % 4]) for (const det of [-7, 7]) osc('sawtooth', mtof(n), t, t + len + 0.5, f).detune.value = det;
    },
    lead(d, t, st, bar, step) {
      const row = MELODY[bar % 4], n = row[st];
      if (n === null) return;
      let len = 1; while (st + len < 16 && row[st + len] === null) len++;
      const o = osc('square', mtof(n), t, t + len * step + 0.1, filt('lowpass', 2200, env(t, 0.02, 0.12, len * step * 0.9, d)));
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.5; lg.gain.value = 12; lfo.connect(lg).connect(o.detune); lfo.start(t); lfo.stop(t + len * step + 0.1);
    },
    choir(d, t, st, bar, step) {
      const len = step * 8;
      for (const n of CHORDS[bar % 4]) {
        const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.15); g.gain.linearRampToValueAtTime(0, t + len); g.connect(d);
        osc('sine', mtof(n + 12), t, t + len, g);
      }
    },
  };
  function click(t, accent) { osc('sine', accent ? 1600 : 1000, t, t + 0.05, env(t, 0.001, 0.3, 0.04, mainGain)); }

  // ---------- transport ----------
  const barDur = () => (4 * 60) / getState().tempo;
  function trigger(S, T, pos, time, step) {
    const bar = Math.floor(pos + 1e-6), st = Math.round((pos - bar) * 16) % 16;
    if (T.metro && st % 4 === 0) click(time, st === 0);
    // Each clip plays its own audio: step k of the clip's part sits at song position zero + k/16, where zero is
    // where the clip's audio starts, so clips can sit anywhere (triplets, 1/32) and move with their content.
    const end = pos + 1 / 16;
    for (const t of S.tracks) for (const c of t.clips) {
      if (c.on === false || !VOICES[c.sound]) continue;
      const zero = c.start - (c.offset ?? c.start), from = Math.max(pos, c.start), to = Math.min(end, c.start + c.len);
      if (from >= to - 1e-9) continue;
      for (let k = Math.ceil((from - zero) * 16 - 1e-6); zero + k / 16 < to - 1e-9; k++) {
        const ls = ((k % 16) + 16) % 16, lb = Math.floor(k / 16);
        if (SOUNDS[c.sound].steps.includes(ls)) VOICES[c.sound](channel(t.id).bus, time + (zero + k / 16 - pos) * step * 16, ls, ((lb % 4) + 4) % 4, step);
      }
    }
  }
  function tick() {
    const S = getState(), T = getTransport(), step = 60 / S.tempo / 4;
    while (next < ctx.currentTime + 0.1) {
      if (T.loop && last < T.loopEnd - 1e-6 && nextPos >= T.loopEnd - 1e-6) nextPos = T.loopStart;
      trigger(S, T, nextPos, next, step);
      marks.push([next, nextPos]);
      last = nextPos; nextPos += 1 / 16; next += step;
    }
  }

  return {
    play(from) {
      init(); ctx.resume(); sync();
      clearInterval(timer); playing = true;
      nextPos = Math.ceil(from * 16 - 1e-6) / 16; last = from - 1e-3;
      const t0 = ctx.currentTime + 0.05;
      next = t0 + (nextPos - from) * barDur(); marks = [[t0, from]];
      timer = setInterval(tick, 25); tick();
    },
    stop() {
      clearInterval(timer); playing = false; marks = [];
      if (!ctx) return;
      for (const c of chans.values()) { // silence notes still ringing or scheduled; effect tails stay
        const old = c.bus;
        old.gain.setTargetAtTime(0, ctx.currentTime, 0.01); setTimeout(() => old.disconnect(), 300);
        c.bus = ctx.createGain(); c.bus.connect(c.input);
      }
    },
    // Plays one bar of a browser sample straight to the Main track.
    preview(sound) {
      init(); ctx.resume();
      const bus = ctx.createGain(), step = 60 / getState().tempo / 4, t0 = ctx.currentTime + 0.05;
      bus.gain.value = 0.5; bus.connect(mainGain);
      for (const st of SOUNDS[sound].steps) VOICES[sound](bus, t0 + st * step, st, 0, step);
      setTimeout(() => bus.disconnect(), (16 * step + 2) * 1000);
    },
    get playing() { return playing; },
    position() {
      if (!playing) return null;
      const now = ctx.currentTime;
      while (marks.length > 1 && marks[1][0] <= now) marks.shift();
      const [t, p] = marks[0];
      return p + Math.max(0, now - t) / barDur();
    },
    sync,
    // Peak level (linear) per track/return id, plus 'main'.
    levels() {
      const out = new Map();
      if (!ctx) return out;
      const peak = an => { an.getFloatTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x)); return m; };
      for (const [id, c] of chans) out.set(id, peak(c.an));
      out.set('main', peak(mainAn));
      return out;
    },
  };
}
