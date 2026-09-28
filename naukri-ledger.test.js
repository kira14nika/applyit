/** node --test naukri-ledger.test.js — uses a temp file, never the real ledger. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./naukri-ledger');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'naukri-ledger.jsonl');
const JOB = 'https://www.naukri.com/job-listings-data-analyst-acme-bengaluru-3-to-8-years-040926023453';

test('numeric Naukri job id', () => {
  assert.strictEqual(L.jobId(JOB), '040926023453');
});

test('same job from different searches → same id', () => {
  assert.strictEqual(L.jobId(JOB + '?src=jobsearchDesk&sid=111&xp=1'), '040926023453');
  assert.strictEqual(L.jobId(JOB + '?src=similarjobs&sid=999#top'), '040926023453');
  assert.strictEqual(L.jobId(JOB + '/'), '040926023453');
});

test('fallback to URL without query when there is no numeric id', () => {
  const u = 'https://careers.acme.com/jobs/data-analyst';
  assert.strictEqual(L.jobId(u + '?utm=naukri'), u);
  // a small trailing number (experience range) is not a job id
  assert.strictEqual(L.jobId('https://www.naukri.com/job-listings-x-3-to-5'), 'https://www.naukri.com/job-listings-x-3-to-5');
});

test('counting and exclusion', () => {
  const f = tmp();
  const now = new Date('2026-09-28T10:00:00');
  const today = L.dayOf(now);
  L.append({ url: JOB + '1', status: 'APPLIED', day: today }, f);
  L.append({ url: JOB + '2', status: 'SKIPPED', day: today, reason: 'chatbot unanswerable' }, f);
  L.append({ url: JOB + '3', status: 'FAILED', day: today, reason: 'no Apply button' }, f);
  L.append({ url: JOB + '4', status: 'APPLIED', day: '2026-09-27' }, f);
  L.append({ url: JOB + '5', status: 'FAILED', day: '2026-09-01' }, f);
  L.append({ url: JOB + '6', status: 'APPLIED', day: today, reason: 'already-applied' }, f);
  const recs = L.load(f);
  assert.strictEqual(L.todayApplied(recs, now), 1, 'only APPLIED on today counts (not already-applied)');
  assert.ok(L.excludedIds(recs).has('0409260234536'), 'already-applied is still excluded');
  const ex = L.excludedIds(recs);
  assert.ok(ex.has('0409260234531') && ex.has('0409260234532') && ex.has('0409260234534'), 'APPLIED + SKIPPED excluded');
  assert.ok(!ex.has('0409260234533') && !ex.has('0409260234535'), 'FAILED stays retryable');
});

test('records survive reload; nothing but whitelisted fields is stored', () => {
  const f = tmp();
  for (let i = 0; i < 3; i++) L.append({ url: `${JOB}${i}?sid=x`, status: 'APPLIED', title: 't' + i, cv: { phone: 'secret' } }, f);
  const recs = L.load(f);
  assert.strictEqual(recs.length, 3);
  assert.deepStrictEqual(Object.keys(recs[0]), ['ts', 'day', 'jobId', 'url', 'title', 'company', 'route', 'status', 'reason']);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('secret'));
  assert.ok(!recs[0].url.includes('?'), 'query stripped from stored url');
});

test('blank, malformed and torn lines do not crash; next append starts a fresh line', () => {
  const f = tmp();
  L.append({ url: JOB, status: 'APPLIED' }, f);
  fs.appendFileSync(f, '\n   \nnot json\n{"status":"APPLIED"}\n{"jobId":"1","status":"DISCOVERED"}\n{"ts":"torn');
  L.append({ url: JOB + '9', status: 'SKIPPED' }, f);
  const recs = L.load(f);
  assert.deepStrictEqual(recs.map((r) => r.jobId), ['040926023453', '0409260234539']);
});

// ---- startRun: daily cap 50, per-run cap 10, separate ----
const NOW = new Date('2026-09-28T10:00:00');
const seed = (applied, extra = []) => {
  const f = tmp();
  for (let i = 0; i < applied; i++) L.append({ url: `${JOB}${i}`, status: 'APPLIED', day: L.dayOf(NOW) }, f);
  for (const r of extra) L.append(r, f);
  return f;
};
const run = (f) => L.startRun({ file: f, now: NOW, dailyCap: 50, perRun: 10 });

test('target: empty → 10, 7 → 10, 49 → 1, 50 → 0', () => {
  assert.strictEqual(run(tmp()).target, 10);
  assert.strictEqual(run(seed(7)).target, 10);
  assert.strictEqual(run(seed(49)).target, 1);
  assert.strictEqual(run(seed(50)).target, 0);
});

test('historical APPLIED, SKIPPED and FAILED do not affect today', () => {
  const f = seed(49, [
    ...Array.from({ length: 5 }, (_, i) => ({ url: `${JOB}h${i}`, status: 'APPLIED', day: '2026-09-27' })),
    ...Array.from({ length: 5 }, (_, i) => ({ url: `${JOB}s${i}`, status: 'SKIPPED', day: L.dayOf(NOW) })),
    ...Array.from({ length: 5 }, (_, i) => ({ url: `${JOB}f${i}`, status: 'FAILED', day: L.dayOf(NOW) })),
  ]);
  const r = run(f);
  assert.strictEqual(r.today, 49);
  assert.strictEqual(r.target, 1);
});

test('browser config carries permanent APPLIED + SKIPPED ids, not old FAILED', () => {
  const f = seed(0, [
    { url: JOB + '?sid=1', status: 'APPLIED', day: '2026-01-01' },
    { url: JOB + '7', status: 'SKIPPED', reason: 'x' },
    { url: JOB + '8', status: 'FAILED', reason: 'x' },
  ]);
  const cfg = run(f).browserConfig();
  assert.deepStrictEqual(cfg.excluded.sort(), ['040926023453', '0409260234537']);
});

test('per-run submitted is separate from the daily count; only counted APPLIED moves them', () => {
  const f = seed(7);
  const r = run(f);
  assert.strictEqual(r.record({ url: JOB + 'a', status: 'APPLIED' }, { count: true }).counted, true);
  r.record({ url: JOB + 'b', status: 'APPLIED', reason: 'already-applied' }); // not counted
  r.record({ url: JOB + 'c', status: 'FAILED', reason: 'unverified' }, { count: true }); // FAILED never counts
  r.record({ url: JOB + 'd', status: 'SKIPPED', reason: 'x' }, { count: true });
  assert.strictEqual(r.submitted, 1);
  assert.strictEqual(r.today, 8);
  assert.strictEqual(r.remaining(), 9);
  assert.ok(r.excluded.has(L.jobId(JOB + 'c')), 'this-run FAILED excluded in memory');
  // the next run sees 8 today (already-applied not counted), and the FAILED job is retryable again
  const next = run(f);
  assert.strictEqual(next.today, 8);
  assert.ok(!next.excluded.has(L.jobId(JOB + 'c')));
  assert.ok(next.excluded.has(L.jobId(JOB + 'b')) && next.excluded.has(L.jobId(JOB + 'd')));
});

test('a failed append counts nothing', () => {
  const r = run(tmp());
  assert.throws(() => r.record({ status: 'APPLIED' }, { count: true }));
  assert.strictEqual(r.submitted, 0);
  assert.strictEqual(r.today, 0);
});

test('questionnaire cap: 2 questionnaire-stage FAILED → next attempt SKIPPED; other FAILED don\'t count', () => {
  const f = tmp();
  const Q = L.QUESTIONNAIRE_STAGE;
  L.append({ url: JOB + 'q', status: 'FAILED', reason: `${Q} ai-error: Gemini HTTP 503` }, f);
  L.append({ url: JOB + 'q', status: 'FAILED', reason: `${Q} unverified (unknown) after: confirmed in page` }, f);
  L.append({ url: JOB + 'o', status: 'FAILED', reason: `${Q} ai-error: x` }, f);                     // only once
  L.append({ url: JOB + 'o', status: 'FAILED', reason: 'no Apply button within 30s' }, f);             // not questionnaire stage
  L.append({ url: JOB + 's', status: 'FAILED', reason: `${Q} ai-error: x` }, f);
  L.append({ url: JOB + 's', status: 'FAILED', reason: `${Q} ai-error: y` }, f);
  L.append({ url: JOB + 's', status: 'SKIPPED', reason: L.REPEATED_QUESTIONNAIRE_FAILURE }, f);         // already capped
  const recs = L.load(f);
  assert.strictEqual(L.questionnaireFailures(recs, L.jobId(JOB + 'q')), 2);
  assert.strictEqual(L.questionnaireFailures(recs, L.jobId(JOB + 'o')), 1);
  assert.deepStrictEqual([...L.repeatedQuestionnaireFailures(recs)], [L.jobId(JOB + 'q')]);
  assert.strictEqual(L.REPEATED_QUESTIONNAIRE_FAILURE, 'human-needed: repeated-questionnaire-failure');
  // recording the SKIPPED makes it permanent, and counts stay untouched
  const r = L.startRun({ file: f, now: new Date() });
  const before = [r.today, r.submitted];
  r.record({ url: JOB + 'q', status: 'SKIPPED', reason: L.REPEATED_QUESTIONNAIRE_FAILURE }, { count: true });
  assert.deepStrictEqual([r.today, r.submitted], before, 'SKIPPED never counts');
  const after = L.load(f);
  assert.ok(L.excludedIds(after).has(L.jobId(JOB + 'q')));
  assert.strictEqual(L.repeatedQuestionnaireFailures(after).size, 0);
});

test('questionnaire cap is wired: page tags the stage, the click gate records SKIPPED before any click', () => {
  const page = fs.readFileSync(path.join(__dirname, 'naukri-auto-apply.js'), 'utf8');
  assert.ok(page.includes("why = `questionnaire-stage: ai-error: ${res.missing}`"));
  assert.ok(page.includes("why = (hadQuestionnaire ? 'questionnaire-stage: ' : '') + 'no confirmation after clicking Apply'"));
  assert.ok(page.includes('{ questionnaire: hadQuestionnaire }'));
  const runner = fs.readFileSync(path.join(__dirname, 'auto-apply-runner.js'), 'utf8');
  const gate = runner.slice(runner.indexOf('function onMayClick'), runner.indexOf('function onMayClick') + 2000);
  assert.ok(gate.indexOf('QCAP.has(id)') < gate.indexOf('const ok = mayClick(POLICY, id)'), 'cap checked before a click is allowed');
  assert.ok(/status: 'SKIPPED', reason: LEDGER_MOD\.REPEATED_QUESTIONNAIRE_FAILURE/.test(gate));
  assert.ok(/QCAP\.delete\(id\);\s+run\.excluded\.add\(id\);\s+markTested\(id\);\s+return false;/.test(gate), 'and returns false (no click)');
});

test('load creates a missing ledger; bad status is rejected', () => {
  const f = tmp();
  assert.deepStrictEqual(L.load(f), []);
  assert.ok(fs.existsSync(f));
  assert.throws(() => L.append({ url: JOB, status: 'APPLYING' }, f));
  assert.throws(() => L.append({ status: 'APPLIED' }, f));
});
