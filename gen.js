// Generates the datasets:
//   data/trials.json + data/trials.csv   the study set: 200 standard trials + the hard trials (used by the app; the CSV is the submission file)
//   data/train.jsonl + data/val.jsonl    chat-format examples for fine-tuning, disjoint from the study set
// Usage: node gen.js [studyN=200] [trainN=3000] [valN=300]
import { mkdirSync, writeFileSync } from 'node:fs';
import { toCSV } from './core.js';
import { generateStudy, generateHard, generateTraining, trialKey } from './dataset.js';
import { trainingExample } from './prompt.js';

const [studyN = 200, trainN = 3000, valN = 300] = process.argv.slice(2).map(Number);
const standard = generateStudy(studyN, 2026).map(t => ({ ...t, set: 'standard', challenge: '' }));
const hard = generateHard(14, 4242);
const study = [...standard, ...hard];
// training/validation exclude the standard trials (as when the model was trained); the hard trials are a kind of
// request the generator never makes for training, which is checked below
const studyKeys = new Set(standard.map(trialKey));
const train = generateTraining(trainN, 7001, 'TR', studyKeys);
const val = generateTraining(valN, 9001, 'VA', new Set([...studyKeys, ...train.map(trialKey)]));

mkdirSync('data', { recursive: true });
writeFileSync('data/trials.json', JSON.stringify(study));
writeFileSync('data/trials.csv', toCSV(study.map(t => ({
  id: t.id, set: t.set, challenge: t.challenge, register: t.register, n_clauses: t.n_clauses, n_calls: t.n_calls, tools: t.tools, ref_types: t.ref_types, value_types: t.value_types,
  instruction: t.instruction, initial_state: t.initial, ground_truth_tool_calls: t.gt, target_state: t.target,
}))));
const jsonl = rows => rows.map(t => JSON.stringify(trainingExample(t))).join('\n') + '\n';
writeFileSync('data/train.jsonl', jsonl(train));
writeFileSync('data/val.jsonl', jsonl(val));

const count = (rows, k) => Object.entries(rows.reduce((m, t) => (String(t[k]).split('|').forEach(v => (m[v] = (m[v] || 0) + 1)), m), {})).sort((a, b) => b[1] - a[1]);
const show = (label, rows) => {
  console.log(`\n${label}: ${rows.length} trials, ${rows.reduce((a, t) => a + t.n_calls, 0)} tool calls`);
  for (const k of ['register', 'n_clauses', 'tools', 'ref_types', 'value_types']) console.log(`  ${k.padEnd(11)} ${count(rows, k).map(([v, c]) => `${v}:${c}`).join('  ')}`);
};
show('study, standard (seed 2026)', standard);
show('study, hard (seed 4242)', hard);
show('train (seed 7001)', train);
const sameText = new Set(study.map(t => t.instruction.toLowerCase())), overlap = train.filter(t => sameText.has(t.instruction.toLowerCase()));
const hardKeys = new Set(hard.map(trialKey)), leaked = [...train, ...val].filter(t => hardKeys.has(trialKey(t)) || hard.some(h => h.instruction.toLowerCase() === t.instruction.toLowerCase()));
console.log(`\nhard trials whose instruction appears in train/val: ${leaked.length}`);
console.log(`\nval: ${val.length} trials. Train trials whose instruction text also appears in the study set (with a different session): ${overlap.length}` +
  (overlap.length ? ` (${[...new Set(overlap.map(t => t.instruction))].slice(0, 8).join(' | ')})` : ''));
