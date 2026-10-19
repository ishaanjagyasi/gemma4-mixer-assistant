// AI-only evaluation: runs a model (through Ollama) on every study trial, applies its tool calls to the session and
// scores the result against the target session with core.js's score().
// Usage: node scripts/eval.js [--model gemma4:e4b] [--label base] [--limit N] [--host http://127.0.0.1:11434]
// Writes results/ai/<label>/: predictions.jsonl (one line per trial, appended as it goes, so a stopped run resumes),
// results.csv (the study set with the model-output column: the submission file) and summary.md (accuracy and the error distribution table).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { TOOLS, applyCalls, score, toCSV, ERROR_TYPES } from '../lib/core.js';
import { messages, readReply } from '../lib/prompt.js';
import { CHALLENGES } from '../lib/dataset.js';

process.chdir(new URL('..', import.meta.url).pathname); // paths below are relative to the repo root

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = opt('model', 'gemma4:e4b'), LABEL = opt('label', MODEL.replace(/[^\w.-]/g, '_')), LIMIT = +opt('limit', Infinity);
const HOST = opt('host', process.env.OLLAMA || 'http://127.0.0.1:11434');
const dir = `results/ai/${LABEL}`, predFile = `${dir}/predictions.jsonl`;
mkdirSync(dir, { recursive: true });

const trials = JSON.parse(readFileSync('data/trials.json', 'utf8')).slice(0, LIMIT);

async function ask(t) {
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // num_ctx: the prompt (rules + session + tools) is ~3.5k tokens, more than Ollama's default context would keep
    body: JSON.stringify({ model: MODEL, messages: messages(t.initial, t.instruction), tools: TOOLS, stream: false, think: false, keep_alive: '30m', options: { temperature: 0, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const r = await res.json(), { calls, content, parseError } = readReply(r.message);
  return { calls, content, parseError, ms: Date.now() - t0, prompt_tokens: r.prompt_eval_count, output_tokens: r.eval_count };
}

// ---- run (resuming from predictions already saved) ----
const done = new Map(existsSync(predFile) ? readFileSync(predFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).map(p => [p.id, p]) : []);
console.log(`${MODEL} on ${trials.length} study trials (${done.size} already done) -> ${dir}`);
for (const [i, t] of trials.entries()) {
  if (done.has(t.id)) continue;
  const out = await ask(t);
  const { state, errors: callErrors } = applyCalls(t.initial, out.calls);
  const s = score(t.initial, t.target, state, t.gt, { parseError: out.parseError, callErrors });
  const row = { id: t.id, ...out, ...s };
  appendFileSync(predFile, JSON.stringify(row) + '\n');
  done.set(t.id, row);
  console.log(`${String(i + 1).padStart(3)}/${trials.length} ${t.id} ${s.success ? 'OK  ' : 'MISS'} f1 ${s.f1.toFixed(2)} ${(out.ms / 1000).toFixed(1)}s ${s.errors.map(e => e.type).join(', ')}`);
}

// ---- tables (rescored from the saved tool calls, so they always follow the current scoring code) ----
const rows = trials.filter(t => done.has(t.id)).map(t => {
  const p = done.get(t.id), { state, errors } = applyCalls(t.initial, p.calls);
  return { t, p: { ...p, ...score(t.initial, t.target, state, t.gt, { parseError: p.parseError, callErrors: errors }) } };
});
const pct = x => `${(100 * x).toFixed(1)}%`;
const mean = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : 0);
const line = (label, xs) => `| ${label} | ${xs.length} | ${pct(mean(xs, x => +x.p.success))} | ${mean(xs, x => x.p.f1).toFixed(3)} | ${mean(xs, x => x.p.precision).toFixed(3)} | ${mean(xs, x => x.p.recall).toFixed(3)} | ${(mean(xs, x => x.p.ms) / 1000).toFixed(1)} |`;
const group = (xs, key, fn, order) => (order ?? [...new Set(xs.map(fn))].sort()).filter(v => xs.some(x => fn(x) === v)).map(v => line(`${key}${v}`, xs.filter(x => fn(x) === v)));
const head = '| Trials | n | Success (exact) | Mean F1 | Precision | Recall | Mean latency (s) |\n|---|---|---|---|---|---|---|';
const std = rows.filter(x => (x.t.set ?? 'standard') === 'standard'), hard = rows.filter(x => x.t.set === 'hard');

const allErrors = rows.flatMap(x => x.p.errors.map(e => ({ ...e, id: x.t.id, set: x.t.set ?? 'standard' })));
const errTable = ERROR_TYPES.map(type => {
  const es = allErrors.filter(e => e.type === type);
  return `| ${type} | ${es.length} | ${allErrors.length ? pct(es.length / allErrors.length) : '0%'} | ${new Set(es.map(e => e.id)).size} | ${es.filter(e => e.set === 'standard').length} | ${es.filter(e => e.set === 'hard').length} |`;
});

const summary = `# AI-only evaluation: ${MODEL}

${rows.length} study trials (${std.length} standard, ${hard.length} hard). Success = the session after the model's tool calls matches
the target session exactly (within tolerance). F1 is over the individual settings that had to change.

${head}
${line('**All**', rows)}
${line('**Standard set**', std)}
${group(std, '&nbsp;&nbsp;register = ', x => x.t.register).join('\n')}
${group(std, '&nbsp;&nbsp;clauses = ', x => x.t.n_clauses).join('\n')}
${hard.length ? `${line('**Hard set**', hard)}\n${group(hard, '&nbsp;&nbsp;', x => x.t.challenge, CHALLENGES).join('\n')}` : ''}

## Error distribution

${allErrors.length} errors in ${rows.filter(x => x.p.errors.length).length} trials.

| Error type | Count | Share of errors | Trials with it | Standard set | Hard set |
|---|---|---|---|---|---|
${errTable.join('\n')}
`;
writeFileSync(`${dir}/summary.md`, summary);
writeFileSync(`${dir}/results.csv`, toCSV(rows.map(({ t, p }) => ({
  id: t.id, set: t.set ?? 'standard', challenge: t.challenge ?? '', register: t.register, n_clauses: t.n_clauses, instruction: t.instruction,
  initial_state: t.initial, ground_truth_tool_calls: t.gt, target_state: t.target, model_output_tool_calls: p.calls, model_text: p.content,
  success: p.success, precision: +p.precision.toFixed(3), recall: +p.recall.toFixed(3), f1: +p.f1.toFixed(3),
  errors: p.errors.map(e => e.type).join('|'), error_details: p.errors, latency_s: +(p.ms / 1000).toFixed(2),
}))));
console.log('\n' + summary);
