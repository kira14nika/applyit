const fs = require('fs');
const assert = require('assert');
const { nextHeadline, uploadedToday } = require('./naukri-helpers');

assert.strictEqual(nextHeadline('Data Analyst'), 'Data Analyst.');
assert.strictEqual(nextHeadline('Data Analyst.'), 'Data Analyst..');
assert.strictEqual(nextHeadline('Data Analyst..'), 'Data Analyst');
assert.strictEqual(nextHeadline('Data Analyst  '), 'Data Analyst.');

for (const h of ['', 'x', 'x.', 'x..', 'x...', 'Ends with a sentence.']) {
  assert.notStrictEqual(nextHeadline(h), h.trimEnd(), `no-op cycle for ${JSON.stringify(h)}`);
}

const now = new Date('2026-08-12T10:00:00');
assert.strictEqual(uploadedToday('Uploaded on Aug 12, 2026', now), true);
assert.strictEqual(uploadedToday('Uploaded on Aug 09, 2026', now), false);
assert.strictEqual(uploadedToday('Uploaded on Aug 9, 2026', now), false);
assert.strictEqual(uploadedToday('Uploaded on: August 12, 2026', now), true);
assert.strictEqual(
  uploadedToday('Profile last updated Aug 12, 2026\nResume\nUploaded on Aug 09, 2026', now),
  false,
  'a today date elsewhere on the page must not mask a stale resume'
);
assert.strictEqual(uploadedToday('Uploaded on', now), false);
assert.strictEqual(uploadedToday('', now), false);

const src = fs.readFileSync(require('path').join(__dirname, 'naukri-auto-apply.js'), 'utf8');
const list = (name) => JSON.parse(
  new RegExp(`${name}:\\s*(\\[[^\\]]*\\])`).exec(src)[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'/g, '"')
    .replace(/,\s*\]$/, ']')
);

const KEYWORDS = list('TITLE_KEYWORDS');
const BLOCKLIST = list('TITLE_BLOCKLIST');

const titleOk = (t) => {
  const lower = t.toLowerCase();
  return KEYWORDS.some((k) => lower.includes(k)) &&
         !BLOCKLIST.some((k) => lower.includes(k));
};

for (const title of [
  'Data Analyst',
  'Senior Data Analyst',
  'Data Analyst - Power BI',
  'Power BI Developer',
  'Power BI Analyst',
  'Business Analyst',
  'BI Analyst',
  'Business Intelligence Analyst',
  'Reporting Analyst',
  'Data Visualization Analyst',
  'SQL Data Analyst',
  'MIS Analyst',
]) {
  assert.ok(titleOk(title), `must apply to: ${title}`);
}

for (const title of [
  'QA Engineer',
  'DevOps Engineer',
  'Engineering Manager',
  '.NET Developer',
]) {
  assert.ok(!titleOk(title), `must skip: ${title}`);
}

for (const title of [
  'Data Analyst QA Engineer',
  'Power BI QA Engineer',
  'Business Analyst DevOps Engineer',
]) {
  assert.ok(!titleOk(title), `keyword matched but blocklist must win: ${title}`);
}

console.log('naukri-helpers: all checks passed');
