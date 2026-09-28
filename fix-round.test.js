// Fix round, parts C–H: low-match gate, walk-ins, pacing, location recheck, run logs, reset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ruleMatch, applyThreshold, canon, isGeneric } = require('./job-match');
const { normalize } = require('./preferences');
const { createRunLog } = require('./run-log');
const { resetTestData, ARCHIVED, PROTECTED } = require('./reset-test-data');
const { buildApplications } = require('./app/data');

const PAGE = fs.readFileSync(path.join(__dirname, 'naukri-auto-apply.js'), 'utf8');
const RUNNER = fs.readFileSync(path.join(__dirname, 'auto-apply-runner.js'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'applyit-'));

// ---------------------------------------------------------------- C: matching + gate
test('C: skill spellings are one skill; generic tags never count', () => {
  assert.strictEqual(canon('Advanced Excel'), 'excel');
  assert.strictEqual(canon('Microsoft Excel'), 'excel');
  assert.strictEqual(canon('MySQL'), 'sql');
  assert.ok(isGeneric('Communication Skills') && !isGeneric('SQL'));
  const m = ruleMatch({ title: 'Analyst', tags: ['Advanced Excel', 'MySQL', 'Communication Skills', 'Coding'] },
    { skills: 'Excel, SQL' }, null);
  assert.deepStrictEqual(m.matchedSkills, ['Excel', 'SQL']);
  assert.deepStrictEqual(m.missingSkills, []);
});

test('C: remote jobs fit when Remote is selected, even with a city chosen', () => {
  const prefs = normalize({ titles: ['Analyst'], cities: [139], workModes: ['remote'] });
  const m = ruleMatch({ title: 'Analyst', location: 'Remote', tags: ['SQL'] }, { skills: 'SQL' }, prefs);
  assert.ok(m.reasons.some((r) => /remote, and you accept remote/.test(r)));
  const off = ruleMatch({ title: 'Analyst', location: 'Remote', tags: ['SQL'] }, { skills: 'SQL' }, normalize({ titles: ['Analyst'], cities: [139], workModes: ['on-site'] }));
  assert.ok(off.reasons.some((r) => /not one of your cities/.test(r)));
});

test('C: threshold defaults to 50% and gates; Off or unknown score never gates', () => {
  const p = normalize({});
  assert.deepStrictEqual(p.matching, { aiEnabled: false, thresholdEnabled: true, threshold: 50 });
  assert.strictEqual(applyThreshold({ score: 49 }, p).belowThreshold, true);
  assert.strictEqual(applyThreshold({ score: 50 }, p).belowThreshold, false);
  assert.strictEqual(applyThreshold({ score: 10 }, normalize({ matching: { thresholdEnabled: false } })).belowThreshold, false);
  assert.strictEqual(applyThreshold({ score: null }, p).belowThreshold, false);
});

test('C: skip reason names score and source; the gate fails open', () => {
  assert.match(RUNNER, /reason: `low-match: \$\{m\.score\}% \(\$\{m\.source === 'ai' \? 'ai' : 'rules'\}\)`/);
  assert.match(PAGE, /async function checkMatch[\s\S]*?catch[\s\S]*?ok: true/);
});

test('C: duplicate postings — same company + near-identical title', () => {
  const src = PAGE.match(/const words = [^\n]+\n\s*const nearSame = [^\n]+/)[0];
  const { nearSame } = new Function(`${src}; return { words, nearSame };`)();
  assert.ok(nearSame('Walk-in Drive for Data Analyst - Pune', 'Walk in Drive for Data Analyst Pune'));
  assert.ok(!nearSame('Data Analyst', 'Senior Data Engineer'));
  assert.match(PAGE, /isDuplicate = \(company, title\) => !!company && opened\.some\(\(o\) => o\.company\.toLowerCase\(\) === company\.toLowerCase\(\) && nearSame/);
});

// ---------------------------------------------------------------- D: walk-ins / no online apply
test('D: a loaded page with no Apply control is decided after 1.5 s, never clicked', () => {
  assert.match(PAGE, /Date\.now\(\) - loadedAt > 1500\) return 'no-apply'/);
  assert.match(PAGE, /reason: `unsupported-apply-route: \$\{other\}`/);
  assert.match(PAGE, /reason: 'no-online-apply'/);
  // the not-applicable branch returns before any click helper is reached
  const branch = PAGE.slice(PAGE.indexOf("if (applyBtn === 'no-apply')"), PAGE.indexOf("return 'not-applicable'"));
  assert.ok(branch.length > 0 && !/\.click\(|clickEl|safeClick/.test(branch));
});

test('D: Applications "Walk-ins" rows carry date and venue', () => {
  const walkIn = { when: '29 Sep - 3 Oct, 10 AM', venue: 'Some venue' };
  const rows = buildApplications({
    ledger: [{ jobId: '1', ts: '2026-09-28T10:00:00Z', day: '2026-09-28', status: 'SKIPPED', reason: 'unsupported-apply-route: I am interested' },
      { jobId: '2', ts: '2026-09-28T10:01:00Z', day: '2026-09-28', status: 'SKIPPED', reason: 'low-match: 30% (rules)' }],
    history: [{ type: 'job', jobId: '1', ts: '2026-09-28T10:00:00Z', mode: 'LIVE', walkIn }],
  });
  assert.deepStrictEqual(rows.find((r) => r.jobId === '1').walkIn, walkIn);
  assert.strictEqual(rows.find((r) => r.jobId === '2').walkIn, null);
});

// ---------------------------------------------------------------- E: pacing
test('E: pause only after a real/simulated apply; DRY 5–15 s, real 45–120 s', () => {
  assert.match(PAGE, /DRY_MIN_DELAY_MS: 5000/);
  assert.match(PAGE, /DRY_MAX_DELAY_MS: 15000/);
  assert.match(PAGE, /MIN_DELAY_MS: 45000/);
  assert.match(PAGE, /MAX_DELAY_MS: 120000/);
  assert.match(PAGE, /if \(ok === true && remaining > 0\) \{\s*const \[lo, hi\] = CONFIG\.DRY_RUN/);
});

// ---------------------------------------------------------------- F: location recheck
test('F: unreadable card location is checked on the job page', () => {
  assert.match(PAGE, /locationUnknown: !cardLoc/);
  assert.match(PAGE, /if \(job\.locationUnknown && applyBtn && LF\)/);
  assert.match(RUNNER, /'filtered'/);
});

// ---------------------------------------------------------------- G: run logs
test('G: run log + events saved with per-page counts and the stop reason', () => {
  const dir = tmp();
  const rl = createRunLog('run-x', dir);
  rl.line('hello');
  rl.event({ state: 'searching' });
  rl.pageSummary({ page: 'p1', text: 'next page', counts: { seen: 20, titleFiltered: 5, excluded: 3, locationFiltered: 2, duplicates: 1, opened: 9 } });
  rl.finish({ reason: 'run target reached', counts: { run: 1 } });
  const log = fs.readFileSync(rl.logPath, 'utf8');
  assert.match(log, /hello/);
  assert.match(log, /seen 20, title-filtered 5, excluded 3, location-filtered 2, duplicates 1, opened 9/);
  assert.match(log, /\[end\] run target reached/);
  const ev = fs.readFileSync(rl.eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
  const sum = ev[ev.length - 1];
  assert.strictEqual(sum.type, 'run-summary');
  assert.strictEqual(sum.reason, 'run target reached');
  assert.strictEqual(sum.pages[0].opened, 9);
  assert.ok(fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8').split(/\r?\n/).includes('runs/'));
});

// ---------------------------------------------------------------- H: reset test data
test('H: reset archives test data and never touches ledger/deferred/profile/prefs', () => {
  const root = tmp();
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  for (const f of PROTECTED) put(f, `keep ${f}`);
  put('naukri-history.jsonl', 'h'); put('ai-state.json', '{}'); put('runs/r1.log', 'x');
  const r = resetTestData({ root, now: new Date('2026-09-28T12:00:00Z') });
  assert.deepStrictEqual(r.moved.sort(), [...ARCHIVED].sort());
  for (const f of ARCHIVED) {
    assert.ok(!fs.existsSync(path.join(root, f)));
    assert.ok(fs.existsSync(path.join(r.archiveDir, f)));
  }
  for (const f of PROTECTED) assert.strictEqual(fs.readFileSync(path.join(root, f), 'utf8'), `keep ${f}`);
  assert.ok(r.archiveDir.startsWith(path.join(root, 'archive')));
  assert.deepStrictEqual(resetTestData({ root }).moved, []); // second reset: nothing left, nothing touched
  assert.ok(fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8').split(/\r?\n/).includes('archive/'));
  assert.match(fs.readFileSync(path.join(__dirname, 'app/main.js'), 'utf8'), /NEVER touched: \$\{R\.PROTECTED\.join/);
});

test('G: an empty page is summarised and a finished search rotates without a 45 s wait', () => {
  assert.match(PAGE, /emit\('page-summary', \{ text: 'no results'/);
  assert.match(RUNNER, /await nap\(searchDone \? 1500 : 45000\)/);
  assert.match(RUNNER, /load\(PREFS_ARG \|\| undefined\)/);
});

test('pagination: a disabled "Next" on the last page ends the search', () => {
  assert.match(PAGE, /nb && !nb\.hasAttribute\('disabled'\) && !\(nb\.tagName === 'A' && !nb\.getAttribute\('href'\)\)/);
});
