/** node --test safety.test.js — modes, click gate, error filter, deferred list. No browser. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMode, mayClick, isBenignRace } = require('./safety');
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
