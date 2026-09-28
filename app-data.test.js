/** node --test app-data.test.js — the desktop app's read-only views (no Electron needed). */
const test = require('node:test');
const assert = require('assert');
const D = require('./app/data');

const ledger = [
  { ts: '2026-09-28T01:00:00Z', day: '2026-09-28', jobId: '1', status: 'FAILED', reason: 'unverified (unknown) after: x', title: 'DA', company: 'Eco' },
  { ts: '2026-09-28T02:00:00Z', day: '2026-09-28', jobId: '1', status: 'APPLIED', reason: 'already-applied', title: 'DA', company: 'Eco' },
  { ts: '2026-09-28T03:00:00Z', day: '2026-09-28', jobId: '2', status: 'APPLIED', reason: 'verified: Applied on reload', title: 'DA', company: 'Leaz' },
  { ts: '2026-09-27T03:00:00Z', day: '2026-09-27', jobId: '3', status: 'SKIPPED', reason: 'human-needed: missing-info', title: 'BA', company: 'X' },
];
const history = [
  { type: 'job', ts: '2026-09-28T03:00:01Z', runId: 'r1', mode: 'LIVE', jobId: '2', location: 'Bengaluru', outcome: { status: 'APPLIED' } },
  { type: 'job', ts: '2026-09-27T03:00:01Z', runId: 'r0', mode: 'LIVE', jobId: '3', location: 'Pune',
    outcome: { status: 'SKIPPED', intervention: { category: 'unanswerable-question', question: 'Team of 20?' } } },
  { type: 'job', ts: '2026-09-28T04:00:00Z', runId: 'r2', mode: 'DRY', jobId: '9', outcome: { status: 'DRY' } },
];
const deferred = [{ ts: '2026-09-28T05:00:00Z', day: '2026-09-28', jobId: '7', title: 'DA', url: 'u' }];

test('applications: latest ledger line wins; already-applied shown separately; deferred included', () => {
  const rows = D.buildApplications({ ledger, history, deferred });
  const by = Object.fromEntries(rows.map((r) => [r.jobId, r]));
  assert.strictEqual(by['1'].category, 'ALREADY_APPLIED', 'FAILED then already-applied → already-applied');
  assert.strictEqual(by['2'].category, 'APPLIED');
  assert.strictEqual(by['2'].location, 'Bengaluru', 'details from history');
  assert.strictEqual(by['3'].category, 'SKIPPED');
  assert.strictEqual(by['7'].category, 'DEFERRED');
  assert.ok(!by['9'], 'a DRY history record is not an application');
  assert.deepStrictEqual(rows.map((r) => r.jobId), ['7', '2', '1', '3'], 'newest first');
});

test('app → runner flags: DRY default, TEST validated, LIVE only with the typed word', () => {
  const { runnerArgs } = require('./app/run-args');
  assert.deepStrictEqual(runnerArgs({}).args, ['naukri']);
  assert.deepStrictEqual(runnerArgs({ mode: 'TEST', only: '190626020642\nhttps://www.naukri.com/job-listings-x-111122223333' }).args,
    ['naukri', '--test', '--only=190626020642,https://www.naukri.com/job-listings-x-111122223333']);
  assert.throws(() => runnerArgs({ mode: 'TEST', only: '' }), /at least one/);
  assert.throws(() => runnerArgs({ mode: 'TEST', only: '12; rm -rf' }), /not a Naukri job/);
  assert.throws(() => runnerArgs({ mode: 'LIVE' }), /LIVE/);
  assert.throws(() => runnerArgs({ mode: 'LIVE', confirmText: 'live' }), /LIVE/, 'case-sensitive');
  assert.deepStrictEqual(runnerArgs({ mode: 'LIVE', confirmText: 'LIVE' }).args, ['naukri', '--live', '--confirm-live']);
  assert.throws(() => runnerArgs({ mode: 'YOLO' }), /unknown mode/);
});

test('AI calls today per provider (history ai-call records, local day)', () => {
  const now = new Date();
  const h = [
    { type: 'ai-call', ts: now.toISOString(), ok: true, provider: 'gemini', usage: { total: 15 } },
    { type: 'ai-call', ts: now.toISOString(), ok: true, provider: 'groq', usage: { total: 26 } },
    { type: 'ai-call', ts: now.toISOString(), ok: true, provider: 'gemini', usage: { total: null } },
    { type: 'ai-call', ts: now.toISOString(), ok: false, provider: null },
    { type: 'ai-call', ts: new Date(now.getTime() - 3 * 86400000).toISOString(), ok: true, provider: 'groq' },
    { type: 'job', ts: now.toISOString() },
  ];
  assert.deepStrictEqual(D.aiCallsToday(h, now), { gemini: 2, groq: 1, failed: 1, tokens: { gemini: 15, groq: 26 } });
});

test('job details: all ledger lines in order, history, category', () => {
  const j = D.jobDetails({ ledger, history, deferred }, '3');
  assert.strictEqual(j.category, 'SKIPPED');
  assert.strictEqual(j.history[0].outcome.intervention.question, 'Team of 20?');
  assert.strictEqual(D.jobDetails({ ledger, history, deferred }, '1').ledger.length, 2);
});

test('reports: daily counts never count already-applied as applied; intervention categories', () => {
  const r = D.buildReports({ ledger, history, deferred });
  const today = r.daily.find((d) => d.day === '2026-09-28');
  assert.strictEqual(today.APPLIED, 1);
  assert.strictEqual(today.ALREADY_APPLIED, 1);
  assert.strictEqual(today.FAILED, 1);
  assert.strictEqual(today.DEFERRED, 1);
  assert.deepStrictEqual(r.outcomes, { APPLIED: 1, ALREADY_APPLIED: 1, SKIPPED: 1, FAILED: 0, DEFERRED: 1 });
  assert.deepStrictEqual(r.interventions, { 'unanswerable-question': 1 });
  assert.strictEqual(r.runs.length, 3);
});
