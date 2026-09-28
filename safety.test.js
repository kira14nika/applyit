/** node --test safety.test.js — modes, click gate, error filter, deferred list. No browser. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMode, mayClick, isBenignRace, aiPreflight } = require('./safety');
const D = require('./naukri-deferred');

const URL1 = 'https://www.naukri.com/job-listings-data-analyst-acme-pune-2-to-5-years-111122223333?src=x';

test('DRY is the default and denies every click', () => {
  const p = parseMode(['node', 'r', 'naukri']);
  assert.strictEqual(p.mode, 'DRY');
  assert.strictEqual(mayClick(p, '111122223333'), false);
});

test('TEST allows only allow-listed ids (ids or job URLs)', () => {
  const p = parseMode(['node', 'r', 'naukri', '--test', `--only=190626020642,${URL1}`]);
  assert.strictEqual(p.mode, 'TEST');
  assert.strictEqual(mayClick(p, '190626020642'), true);
  assert.strictEqual(mayClick(p, '111122223333'), true, 'URL entries are allow-listed by their job id');
  assert.strictEqual(mayClick(p, '999999999999'), false);
  assert.strictEqual(mayClick(p, ''), false);
  assert.deepStrictEqual(p.directUrls, [URL1]);
});

test('LIVE allows only once confirmed', () => {
  const unconfirmed = parseMode(['node', 'r', 'naukri', '--live']);
  assert.strictEqual(unconfirmed.mode, 'LIVE');
  assert.strictEqual(mayClick(unconfirmed, '111122223333'), false, 'no --confirm-live, no prompt yet');
  const p = parseMode(['node', 'r', 'naukri', '--live', '--confirm-live']);
  assert.strictEqual(mayClick(p, '111122223333'), true);
});

test('bad mode combinations are rejected', () => {
  assert.throws(() => parseMode(['--test']), /--only/);
  assert.throws(() => parseMode(['--live', '--test', '--only=1']), /not both/);
  assert.throws(() => parseMode(['--only=123']), /--test/);
});

test('missing policy or garbage never allows a click', () => {
  assert.strictEqual(mayClick(null, '1'), false);
  assert.strictEqual(mayClick({ mode: 'TEST', allow: ['1'] }, '1'), false, 'allow must be a Set');
  assert.strictEqual(mayClick({ mode: 'WHATEVER' }, '1'), false);
});

test('only known navigation races are benign', () => {
  assert.ok(isBenignRace(new Error('cdpSession.send: Target page, context or browser has been closed')));
  assert.ok(isBenignRace(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')));
  assert.ok(!isBenignRace(new Error("Cannot read properties of undefined (reading 'x')")));
  assert.ok(!isBenignRace(new TypeError('ledger: bad status')));
});

test('the page script asks the click gate before its click sequence', () => {
  const src = fs.readFileSync(path.join(__dirname, 'naukri-auto-apply.js'), 'utf8');
  const gate = src.indexOf('window.__aaMayClick(job.id)');
  const click = src.indexOf("applyBtn.dispatchEvent(new MouseEvent('click'");
  assert.ok(gate > 0 && click > 0 && gate < click, 'gate must come before the Apply click');
  assert.ok(/if \(!allowed\) \{ log\(.*\); return 'denied'; \}/.test(src), 'denied must return without clicking');
});

test('AI preflight: DRY runs without AI; TEST/LIVE need at least one working provider, warning with only one', () => {
  const none = { gemini: { ok: false, reason: 'GEMINI_KEY is not set' }, groq: { ok: false, reason: 'GROQ_API_KEY is not set' } };
  const one = { gemini: { ok: true, reason: 'responded' }, groq: { ok: false, reason: 'GROQ_API_KEY is not set' } };
  const both = { gemini: { ok: true, reason: 'responded' }, groq: { ok: true, reason: 'responded' } };
  assert.strictEqual(aiPreflight('DRY', none).ok, true);
  assert.strictEqual(aiPreflight('DRY', undefined).ok, true);
  for (const mode of ['TEST', 'LIVE']) {
    assert.strictEqual(aiPreflight(mode, none).ok, false);
    assert.match(aiPreflight(mode, none).reason, /gemini: GEMINI_KEY is not set; groq: GROQ_API_KEY is not set.*answer-engine\.js --check/);
    assert.strictEqual(aiPreflight(mode, undefined).ok, false, 'no check = refuse');
    const p1 = aiPreflight(mode, one);
    assert.deepStrictEqual([p1.ok, p1.working], [true, ['gemini']]);
    assert.match(p1.warning, /only gemini works.*groq: GROQ_API_KEY is not set/);
    assert.deepStrictEqual([aiPreflight(mode, both).ok, aiPreflight(mode, both).warning], [true, null]);
  }
});
test('runner: the AI preflight runs before the LIVE prompt and before Chrome launches', () => {
  const src = fs.readFileSync(path.join(__dirname, 'auto-apply-runner.js'), 'utf8');
  const body = src.slice(src.indexOf('(async () => {'));
  const pre = body.indexOf('aiPreflight(MODE, checks)');
  assert.ok(pre > 0, 'preflight present');
  assert.ok(pre < body.indexOf("rl.question('Type LIVE"), 'before the LIVE prompt');
  assert.ok(pre < body.indexOf('await launch()'), 'before launching Chrome');
  assert.ok(/if \(!pf\.ok\) \{ log\(`Refusing \$\{MODE\}: \$\{pf\.reason\}`\); process\.exit\(1\); \}/.test(body), 'refusal exits');
});

test('deferred list: parks once, survives reload, never touches the ledger format', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-')), 'naukri-deferred.jsonl');
  assert.ok(D.defer({ url: URL1, title: 'Data Analyst' }, f));
  assert.strictEqual(D.defer({ url: URL1 + '&sid=2', title: 'dup' }, f), null, 'same job id is parked once');
  const recs = D.load(f);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].jobId, '111122223333');
  assert.strictEqual(recs[0].route, 'external');
  assert.ok(!('status' in recs[0]), 'not a ledger outcome');
  assert.ok(D.ids(recs).has('111122223333'));
});
