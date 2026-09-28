/** node --test answer-engine.test.js — Gemini is mocked; nothing leaves the machine. */
const test = require('node:test');
const assert = require('assert');
const E = require('./answer-engine');

const CV = {
  name: 'Test User', email: 'user@example.com', phone: '+91 90000 00000', location: 'Pune',
  currentRole: 'Data Analyst at Acme', company: 'Acme', education: 'B.Sc', yearsOfExperience: '3',
  skills: 'SQL, Power BI', highlights: ['Built KPI dashboards'], noticePeriod: '30 days',
  currentCTC: '6', expectedCTC: '8-10', dob: '01/01/2000', gender: 'Female',
  workAuth: 'Authorized to work in my country of residence.', // config default, not user data
  remoteOk: 'Yes, I am fully set up for remote work', relocate: 'Yes, I am open to relocation.',
  linkedin: '', github: '', portfolio: '',
};
const FACTS = E.buildFacts(CV);

/** A fetch that returns `body` as Gemini's JSON text and records the request. */
const geminiReturns = (obj, calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), headers: { get: () => null } };
};
const { createAi } = require('./ai-providers');
// the real provider chain (Gemini only here), transport mocked, no waiting
const ask = (q, fetchImpl, apiKey = 'test-key') => E.answer(q, { facts: FACTS,
  ai: apiKey ? createAi({ gemini: { apiKey, model: 'm' } }, { fetchImpl, stateFile: null, sleep: async () => {} }) : null });

test('facts: only the user\'s own non-empty data; derived sentences and defaults dropped', () => {
  assert.ok(!('remoteOk' in FACTS) && !('relocate' in FACTS), 'derived sentences are not facts');
  assert.ok(!('workAuthorization' in FACTS), 'the config default is not a fact');
  assert.ok(!('linkedin' in FACTS), 'empty values are not facts');
  assert.strictEqual(FACTS.currentCompany, 'Acme');
});

test('factual lookup answers directly, without AI', async () => {
  const calls = [];
  const r = await ask({ question: 'Email address' }, geminiReturns({}, calls));
  assert.deepStrictEqual([r.status, r.answer, r.source], ['answered', 'user@example.com', 'fact']);
  assert.strictEqual(calls.length, 0);
  const n = await ask({ question: 'Notice period (in days)?', numeric: true }, geminiReturns({}, calls));
  assert.strictEqual(n.answer, '30');
});

test('empty profile value is never answered from facts', async () => {
  const r = await ask({ question: 'LinkedIn profile URL?' }, null, ''); // no key either
  assert.strictEqual(r.status, 'unknown');
});

test('a range is not collapsed into a number', async () => {
  const r = await ask({ question: 'Expected CTC (in lakhs)?', numeric: true }, geminiReturns({ status: 'unknown', missing: 'single expected CTC figure' }));
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.category, 'missing-info');
});

test('AI answered: accepted with evidence', async () => {
  const r = await ask({ question: 'Why do you want this role?', job: { title: 'Data Analyst' } },
    geminiReturns({ status: 'answered', answer: 'I build KPI dashboards and this role centres on them.', evidence: 'highlights[0], JOB.title' }));
  assert.strictEqual(r.status, 'answered');
  assert.strictEqual(r.source, 'ai');
});

test('AI unknown → unknown with category', async () => {
  const r = await ask({ question: 'How many years have you managed a team of 20 people?' },
    geminiReturns({ status: 'unknown', answer: '', missing: 'team management history' }));
  assert.deepStrictEqual([r.status, r.category], ['unknown', 'missing-info']);
});

test('invalid option → unknown', async () => {
  const r = await ask({ question: 'Are you willing to relocate?', options: ['Yes', 'No'] },
    geminiReturns({ status: 'answered', answer: 'yes, happily', evidence: 'x' }));
  assert.strictEqual(r.status, 'unknown');
  const ok = await ask({ question: 'Highest qualification?', options: ['B.Sc', 'M.Sc'] },
    geminiReturns({ status: 'answered', answer: 'B.Sc', evidence: 'education' }));
  assert.strictEqual(ok.answer, 'B.Sc', 'a verbatim option is accepted');
});

test('invalid number → unknown', async () => {
  const r = await ask({ question: 'How many years of experience in SQL?', numeric: true },
    geminiReturns({ status: 'answered', answer: 'about 3', evidence: 'totalExperience' }));
  assert.strictEqual(r.status, 'unknown');
});

test('answer without evidence → unknown', async () => {
  const r = await ask({ question: 'Describe your Power BI experience' }, geminiReturns({ status: 'answered', answer: 'Lots.', evidence: '' }));
  assert.strictEqual(r.status, 'unknown');
});

test('API errors → unknown/ai-error, never a fallback answer', async () => {
  const http = await ask({ question: 'Describe a project' }, async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }));
  assert.deepStrictEqual([http.status, http.category], ['unknown', 'ai-error']);
  const thrown = await ask({ question: 'Describe a project' }, async () => { throw new Error('ECONNRESET'); });
  assert.deepStrictEqual([thrown.status, thrown.category], ['unknown', 'ai-error']);
  const junk = await ask({ question: 'Describe a project' }, async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }));
  assert.strictEqual(junk.status, 'unknown');
  assert.ok(!('answer' in http) && !('answer' in thrown) && !('answer' in junk));
});

test('no AI provider → ai-error (retryable FAILED), never a human-needed SKIPPED; no request made', async () => {
  const calls = [];
  const r = await ask({ question: 'Describe a project' }, geminiReturns({}, calls), '');
  assert.deepStrictEqual([r.status, r.category], ['unknown', 'ai-error']);
  assert.strictEqual(calls.length, 0);
});

test('the page script holds no answers, no CV and no key', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'naukri-auto-apply.js'), 'utf8');
  for (const gone of ['QA_BANK', 'GENERIC_ANSWER', 'answerQuestion', 'geminiKey', 'generativelanguage', '__CFG.CV', 'options[0]']) {
    assert.ok(!src.includes(gone), `naukri-auto-apply.js must not contain ${gone}`);
  }
  assert.ok(src.includes('window.__aaAnswer'), 'answers come from the runner');
});

test('key travels in a header, not the URL; contact details only when asked', async () => {
  const calls = [];
  await ask({ question: 'Describe your Power BI work' }, geminiReturns({ status: 'unknown', missing: 'x' }, calls));
  assert.ok(!calls[0].url.includes('test-key'));
  assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'test-key');
  const sent = calls[0].init.body;
  assert.ok(!sent.includes('user@example.com') && !sent.includes('90000') && !sent.includes('01/01/2000'), 'no email/phone/DOB for an unrelated question');
  assert.ok(sent.includes('Power BI'));
});
