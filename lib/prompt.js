// What the model sees: the system prompt (the rules for reading producer language), the session as text, and the
// tools. Used verbatim by the app, the evaluation script and the training export so they always match.
import { TOOLS, fmtVol, fmtPan, trackLabels } from './core.js';
import { DEVICES, fmtParam } from './catalog.js';

export const SYSTEM = `You are the assistant inside a music production app modelled on Ableton Live's Arrangement View. A producer or sound engineer tells you what to change, and you make the change by calling the tools. The current session is given with each request.

How to read requests:
- Make one tool call per change, in the order asked. For a group, call the tool once for each track in it: "the drums"/"the drum tracks" = every [drums] track, "the vocals"/"the vocal tracks" = every [vocals] track, "everything"/"all the tracks" = every track.
- Name tracks exactly as in the session (e.g. "Lead Vox"), or "track N" for the N-th track listed. The return tracks are "A Reverb" and "B Delay"; the master/main output is "Main".
- Volume: "to X dB"/"at X dB" sets the level. "up/down X dB" and "boost/cut/drop/push/pull/raise/lower X dB" change it (relative = true). -inf = -70. "unity" = 0 dB.
- Vague amounts: "a touch", "a hair", "a tad", "slightly" = 1 dB; "a bit", "a little", "a couple dB" = 2 dB; "a few dB" = 3 dB; "a lot", "quite a bit", "way up/down" = 6 dB.
- Pan runs from -50 (hard left) to 50 (hard right): "30L"/"30 left" = -30; "hard left" = -50; "halfway left" = -25; "a little/slightly/a bit left" = -15; "center"/"middle" = 0.
- "Reverb"/"delay" as an amount means the send: "reverb" = send A (A Reverb), "delay" = send B (B Delay). "more"/"less" = +3/-3 dB, "a bit more"/"a little less" = +2/-2 dB, "some" (when the send is off) = -15 dB, "no reverb" = -inf. "a reverb"/"a delay" means adding that effect.
- "Boost/cut the lows/mids/highs" changes the Low/Mid/High band of that track's EQ Eight (relative).
- Mute: "kill", "silence", "deactivate", "turn off". Unmute: "bring back", "turn back on". Solo: "isolate", "let me hear just". Arm: "record-enable", "get ready to record".
- "Half time" halves the tempo; "double time" doubles it.
- Bars are numbered from 1; "bars 5 to 8" includes bars 5 and 8.
- Only call tools. Do not explain.`;

const bars = (a, len) => { const f = x => +(x + 1).toFixed(2); return len <= 1 ? `bar ${f(a)}` : `bars ${f(a)}-${+(a + len).toFixed(2)}`; };
const fxText = d => `${d.type}${d.on ? '' : ' (off)'} (${DEVICES[d.type].params.map(p => `${p.label} ${fmtParam(p, d.params[p.label])}`).join(', ')})`;
// The session as plain text, one line per track.
export function stateText(s) {
  const L = [
    `Tempo ${s.tempo} BPM. Metronome ${s.metronome ? 'on' : 'off'}. Transport ${s.transport ?? 'stopped'}. Insert marker at bar ${+((s.marker ?? 0) + 1).toFixed(2)}. ` +
    `Loop ${s.loop?.on ? 'on' : 'off'}, ${bars(s.loop?.start ?? 0, (s.loop?.end ?? 4) - (s.loop?.start ?? 0))}. Main volume ${fmtVol(s.main?.vol ?? 0)} dB.`,
    'Tracks (position. name [group]: volume, pan, status | sends | effects | clips):',
  ];
  const labels = trackLabels(s);
  s.tracks.forEach((t, i) => {
    const status = [t.on ? 'on' : 'muted', t.solo && 'soloed', t.arm && 'armed'].filter(Boolean).join(', ');
    const clips = t.clips.map(c => `${c.name} ${bars(c.start, c.len)}${c.on === false ? ' (off)' : ''}`).join('; ') || 'none';
    L.push(`${i + 1}. ${labels[i]} [${t.group ?? 'other'}]: ${fmtVol(t.vol)} dB, ${fmtPan(t.pan)}, ${status} | sends A ${fmtVol(t.sends.A)} dB, B ${fmtVol(t.sends.B)} dB | effects: ${t.devices.map(fxText).join(' > ') || 'none'} | clips: ${clips}`);
  });
  // Only when names repeat (never in the datasets): the trained model has not seen this case, so spell it out.
  const twins = labels.filter(l => / #\d+$/.test(l));
  if (twins.length) L.push(`Note: ${twins.join(', ')} are separate tracks that share a name. When the request describes which one (e.g. "the one with audio", "the empty one"), change only that track.`);
  L.push('Return tracks:');
  for (const r of s.returns) L.push(`${r.name}: ${fmtVol(r.vol)} dB, ${fmtPan(r.pan)}, ${[r.on ? 'on' : 'muted', r.solo && 'soloed'].filter(Boolean).join(', ')} | effects: ${r.devices.map(fxText).join(' > ') || 'none'}`);
  // What the user is looking at in the app (absent in the datasets): lets "this track", "it" and "here" be resolved.
  const v = s.view;
  if (v) {
    const R = v.range;
    L.push(`On screen: selected ${v.selected.length ? `track${v.selected.length > 1 ? 's' : ''} ${v.selected.join(', ')}` : 'nothing'}` +
      `${R ? `; time selection ${bars(R.start, R.end - R.start)} on ${R.tracks.join(', ')}` : ''}` +
      `${v.playhead !== null && v.playhead !== undefined ? `; playing at bar ${+(v.playhead + 1).toFixed(2)}` : ''}.` +
      ` "This track"/"it"/"the selected track" means the selected track; "here"/"this part" means the time selection (or the insert marker if there is none).`);
  }
  return L.join('\n');
}

export const userMessage = (s, instruction) => `Session:\n${stateText(s)}\n\nRequest: ${instruction}`;
export const messages = (s, instruction) => [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMessage(s, instruction) }];
// One chat-format training example: the conversation, the tools, and the correct tool calls as the answer.
export const trainingExample = t => ({
  messages: [...messages(t.initial, t.instruction), { role: 'assistant', content: '', tool_calls: t.gt.map(c => ({ type: 'function', function: { name: c.name, arguments: c.arguments } })) }],
  tools: TOOLS,
});

// The tool calls in a reply from Ollama's /api/chat, as [{ name, arguments }]. Gemma 4 writes calls as
// <|tool_call>call:name{key:<|"|>text<|"|>,n:5}<tool_call|>; Ollama normally turns these into message.tool_calls, and
// if a model's calls come back as plain text instead they are read here. parseError: it tried to call tools but the
// text can't be read.
const CALL = /<\|tool_call>call:(\w+)\{([\s\S]*?)\}<tool_call\|>/g;
export function readReply(message) {
  const content = message?.content ?? '';
  let calls = (message?.tool_calls ?? []).map(c => ({ name: c.function.name, arguments: c.function.arguments })), parseError = false;
  if (!calls.length && content.trim()) {
    const fromText = [];
    for (const [, name, body] of content.matchAll(CALL)) {
      const json = ('{' + body.replaceAll('<|"|>', '"') + '}').replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":');
      try { fromText.push({ name, arguments: JSON.parse(json) }); } catch { parseError = true; }
    }
    if (fromText.length && !parseError) calls = fromText;
    else parseError = /tool_call|call:|\{/.test(content);
  }
  return { calls, content, parseError };
}
