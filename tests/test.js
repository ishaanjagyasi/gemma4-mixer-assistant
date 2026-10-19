import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCalls, score, diff, clone, TOOL_NAMES } from '../lib/core.js';
import { generateStudy, generateHard, generateTraining, trialKey, session, CHALLENGES } from '../lib/dataset.js';
import { rng } from '../lib/core.js';

const study = generateStudy(200, 2026);

test('study set is deterministic, stratified and covers every tool', () => {
  assert.deepEqual(generateStudy(200, 2026), study);
  const by = n => study.filter(t => t.n_clauses === n).length;
  assert.deepEqual([by(1), by(3), by(6)], [67, 67, 66]);
  const used = new Set(study.flatMap(t => t.gt.map(c => c.name)));
  assert.deepEqual(TOOL_NAMES.filter(n => !used.has(n)), []);
  for (const k of ['name', 'number', 'group']) assert.ok(study.some(t => t.ref_types.split('|').includes(k)), k);
});

test('ground truth scores 100%, doing nothing scores 0', () => {
  for (const t of study) {
    const { state, errors } = applyCalls(t.initial, t.gt);
    assert.deepEqual(errors, [], t.id);
    const good = score(t.initial, t.target, state, t.gt);
    assert.ok(good.success && good.f1 === 1 && good.errors.length === 0, t.id);
    const none = score(t.initial, t.target, clone(t.initial), t.gt);
    assert.ok(!none.success && none.recall === 0 && none.f1 === 0, t.id);
  }
});

test('error tags', () => {
  const s = session(rng(1), 'study');
  s.tracks[0].vol = -10; s.tracks[3].pan = 0;
  const gt = [{ name: 'set_volume', arguments: { track: 'Kick', db: 3, relative: true } }, { name: 'set_pan', arguments: { track: 'Bass', pan: -30 } }, { name: 'set_solo', arguments: { track: 'Pad', soloed: !s.tracks[5].solo } }];
  const target = applyCalls(s, gt).state;
  const tags = calls => { const r = applyCalls(s, calls); return score(s, target, r.state, gt, { callErrors: r.errors }).errors.map(e => e.type).sort(); };
  assert.deepEqual(tags([{ name: 'set_volume', arguments: { track: 'Kick', db: 3 } }, { name: 'set_pan', arguments: { track: 'Bass', pan: 30 } }, { name: 'set_solo', arguments: { track: 'Keys', soloed: !s.tracks[4].solo } }]),
    ['pan side flipped', 'relative read as absolute', 'wrong track']);
  assert.deepEqual(tags([...gt, { name: 'set_arm', arguments: { track: 'Snare', armed: !s.tracks[1].arm } }]), ['extra unrequested change']);
  assert.deepEqual(tags([{ name: 'set_volume', arguments: { track: 'Kick', db: -12 } }]), ['omitted edit', 'omitted edit', 'wrong value']);
  assert.deepEqual(tags([...gt, { name: 'delete_track', arguments: { track: 'Hats' } }, { name: 'set_wobble', arguments: {} }]), ['invalid tool call', 'wrong track structure']);
  assert.deepEqual(score(s, target, s, gt, { parseError: true }).errors.map(e => e.type), ['parse error']);
});

test('track structure: inserts line up by order, deletes count once', () => {
  const s = session(rng(2), 'study');
  const ins = applyCalls(s, [{ name: 'insert_track', arguments: { name: 'Shaker', after: 'Bass' } }]).state;
  assert.equal(ins.tracks[4].name, 'Shaker');
  assert.deepEqual(diff(s, ins).sort(), ['order', `t:${ins.tracks[4].id}.exists`, `t:${ins.tracks[4].id}.name`].sort());
  const del = applyCalls(s, [{ name: 'delete_track', arguments: { track: 'track 2' } }]).state;
  assert.deepEqual(diff(s, del).sort(), ['order', 't:T2.exists']);
});

test('training data never repeats a study trial', () => {
  const keys = new Set(study.map(trialKey)), train = generateTraining(300, 7001, 'TR', keys);
  assert.equal(train.filter(t => keys.has(trialKey(t))).length, 0);
  assert.equal(new Set(train.map(trialKey)).size, train.length);
});

test('hard trials: every challenge, ground truth scores 100%, duplicate names resolved', () => {
  const hard = generateHard(14, 4242);
  assert.deepEqual(generateHard(14, 4242), hard);
  assert.deepEqual([...new Set(hard.map(t => t.challenge))], CHALLENGES);
  for (const t of hard) {
    const { state, errors } = applyCalls(t.initial, t.gt);
    assert.deepEqual(errors, [], t.id);
    assert.ok(score(t.initial, t.target, state, t.gt).success, t.id);
  }
  // with two tracks named Snare, a bare "Snare" is refused and "Snare #2" picks the second
  const s = applyCalls(session(rng(3), 'study'), [{ name: 'duplicate_track', arguments: { track: 'Snare' } }]).state;
  assert.match(applyCalls(s, [{ name: 'set_mute', arguments: { track: 'Snare', muted: true } }]).errors[0], /could be Snare #1 or Snare #2/);
  assert.equal(applyCalls(s, [{ name: 'set_mute', arguments: { track: 'Snare #2', muted: true } }]).state.tracks[2].on, false);
});
