/** node --test run-events.test.js — event bus, IPC mirror, job tracker, history file. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STATES, PAGE_STATES, createBus, createTracker } = require('./run-events');
const H = require('./naukri-history');

test('events carry runId, increasing seq and a timestamp; unknown states throw', () => {
  const bus = createBus({ runId: 'r1', mode: 'DRY', send: null });
  const seen = [];
  bus.on('event', (e) => seen.push(e));
  bus.emitState('starting', { text: 'go' });
  bus.emitState('searching', { search: 'q', page: 'p1' });
  assert.deepStrictEqual(seen.map((e) => [e.runId, e.seq, e.state]), [['r1', 1, 'starting'], ['r1', 2, 'searching']]);
  assert.ok(seen[0].ts);
  assert.throws(() => bus.emitState('teleporting'), /unknown state/);
  assert.strictEqual(bus.snapshot.page, 'p1');
});

test('events are mirrored to process.send when forked', () => {
  const sent = [];
  const bus = createBus({ runId: 'r2', mode: 'DRY', send: (m) => sent.push(m) });
  bus.emitState('checking-job', { jobId: '1', job: { id: '1', title: 'Data Analyst' } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'event');
  assert.strictEqual(sent[0].event.state, 'checking-job');
  assert.strictEqual(sent[0].snapshot.job.title, 'Data Analyst');
});

test('tallies: already-applied is separate from applied; counts are copied, not computed', () => {
  const bus = createBus({ runId: 'r3', mode: 'LIVE', send: null });
  bus.emitState('application-verified', { counts: { run: 1, today: 5 } });
  bus.emitState('already-applied', {});
  bus.emitState('skipped', { reason: 'human-needed: missing-info' });
  bus.emitState('failed', {});
  assert.deepStrictEqual(bus.snapshot.tallies, { applied: 1, alreadyApplied: 1, skipped: 1, failed: 1, deferred: 0, wouldApply: 0 });
  assert.strictEqual(bus.snapshot.counts.today, 5);
  assert.strictEqual(bus.snapshot.lastResult.state, 'failed', 'last result is the most recent outcome');
});

test('page states are a subset of the known states', () => {
  for (const s of PAGE_STATES) assert.ok(STATES.includes(s), s);
  assert.ok(!PAGE_STATES.includes('application-verified'), 'only Node may declare an application verified');
});

test('tracker writes ONE history record per job with timeline, questions and outcome', () => {
  const written = [];
  const bus = createBus({ runId: 'r4', mode: 'TEST', send: null });
  const t = createTracker({ bus, write: (r) => written.push(r) });
  t.touch('42', { title: 'Data Analyst', company: 'Acme', location: 'Pune', search: 'q', page: 'p2' });
  t.event('42', 'checking-job', { text: 'checking' });
  t.event('42', 'generating-answer', { question: 'Notice period?' });
  t.question('42', { question: 'Notice period?', result: { status: 'answered', answer: '30', evidence: 'profile.noticePeriod' } });
  t.finish('42', { status: 'SKIPPED', reason: 'human-needed: missing-info', intervention: { category: 'missing-info' } }, 'skipped');
  assert.strictEqual(written.length, 1);
  const r = written[0];
  assert.strictEqual(r.type, 'job');
  assert.strictEqual(r.jobId, '42');
  assert.strictEqual(r.location, 'Pune');
  assert.deepStrictEqual(r.timeline.map((x) => x.state), ['checking-job', 'generating-answer', 'skipped']);
  assert.strictEqual(r.questions[0].result.answer, '30');
  assert.strictEqual(r.outcome.intervention.category, 'missing-info');
  t.event('42', 'checking-job', {});
  t.finish('42', { status: 'DRY' }, null);
  assert.strictEqual(written[1].timeline.length, 1, 'a finished job starts a fresh record');
});

test('a failing history writer never breaks the run', () => {
  const bus = createBus({ runId: 'r5', mode: 'DRY', send: null });
  const t = createTracker({ bus, write: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => t.finish('1', { status: 'DRY' }, 'would-apply'));
});

test('history file: append needs a type, survives reload', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'naukri-history.jsonl');
  H.append({ type: 'job', runId: 'x', jobId: '1' }, f);
  H.append({ type: 'job', runId: 'x', jobId: '2' }, f);
  assert.throws(() => H.append({ jobId: '3' }, f), /type/);
  assert.deepStrictEqual(H.load(f).map((r) => r.jobId), ['1', '2']);
  assert.match(H.newRunId(new Date('2026-09-28T10:00:00Z')), /^20260928T100000-[a-z0-9]{4}$/);
});
