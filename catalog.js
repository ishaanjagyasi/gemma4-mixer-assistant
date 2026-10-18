// Static catalog shared by the app, the audio engine, the assistant's tools and the dataset generator:
// Live's audio effects and their parameters, the browser samples, and the named track colors.
const P = (label, min, max, def, unit, log = false) => ({ label, min, max, def, unit, log });
export const DEVICES = {
  'EQ Eight': { info: 'Equalizer. Boosts or cuts the low (200 Hz shelf), mid (1 kHz bell) and high (5 kHz shelf) frequencies.', params: [P('Low', -15, 15, 0, 'dB'), P('Mid', -15, 15, 0, 'dB'), P('High', -15, 15, 0, 'dB')] },
  'Auto Filter': { info: 'Low-pass filter. Lower the frequency to make the track darker; raise the resonance to emphasise the cutoff.', params: [P('Freq', 40, 20000, 20000, 'Hz', true), P('Res', 0, 100, 0, '%')] },
  'Compressor': { info: 'Reduces the level of loud parts above the threshold, by the ratio, so the track sounds more even.', params: [P('Thresh', -40, 0, -18, 'dB'), P('Ratio', 1, 20, 4, ':1'), P('Attack', 1, 100, 10, 'ms', true)] },
  'Saturator': { info: 'Adds warmth and distortion. Drive pushes the signal into saturation; Output compensates the level.', params: [P('Drive', 0, 24, 6, 'dB'), P('Output', -24, 0, -6, 'dB')] },
  'Delay': { info: 'Echo effect. Time sets the gap between echoes, Feedback how many repeat, Dry/Wet how loud they are.', params: [P('Time', 20, 1000, 375, 'ms', true), P('Feedback', 0, 90, 35, '%'), P('Dry/Wet', 0, 100, 25, '%')] },
  'Reverb': { info: 'Simulates a room. Decay sets the length of the reverb tail, Dry/Wet how much of it is heard.', params: [P('Decay', 0.3, 8, 2, 's', true), P('Dry/Wet', 0, 100, 25, '%')] },
  'Utility': { info: 'Utility. Changes the gain (level) before the track fader and balances the signal left or right.', params: [P('Gain', -24, 24, 0, 'dB'), P('Balance', -50, 50, 0, '')] },
};
export const deviceDefaults = type => Object.fromEntries(DEVICES[type].params.map(p => [p.label, p.def]));
export function fmtParam(p, v) {
  if (p.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (p.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (p.unit === ':1') return `${v.toFixed(1)} : 1`;
  if (p.unit === 's') return `${v.toFixed(2)} s`;
  if (p.unit === '') { const r = Math.round(v); return r === 0 ? 'C' : `${Math.abs(r)}${r < 0 ? 'L' : 'R'}`; }
  return `${Math.round(v)} ${p.unit}`;
}

// Browser samples (loops) and the part each one plays.
export const SAMPLES = {
  'Kick Loop': 'kick', 'Snare Loop': 'snare', 'Clap Loop': 'clap', 'Hat Loop': 'hats', 'Shaker Loop': 'shaker', 'Perc Loop': 'perc',
  'Bass Line': 'bass', 'Sub Bass': 'sub', 'Chord Stabs': 'keys', 'Arp Pluck': 'arp', 'Pad Wash': 'pad', 'Vocal Lead': 'lead', 'Vocal Oohs': 'choir',
};
// Track colors the assistant can use by name (a subset of the app's palette).
export const COLORS = {
  red: '#ff3636', orange: '#ffa529', yellow: '#f7f47c', lime: '#bffb00', green: '#1aff2f', mint: '#25ffa8', cyan: '#5cffe8',
  'light blue': '#8bc5ff', blue: '#5480e4', purple: '#886ce4', magenta: '#d86ce4', pink: '#ff94a6', brown: '#99724b', white: '#ffffff', grey: '#d0d0d0',
};
