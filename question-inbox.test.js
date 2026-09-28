/** node --test question-inbox.test.js — "Needs your answer" inbox. No network (AI mocked). */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('./question-inbox');
const E = require('./answer-engine');
const L = require('./naukri-ledger');
const R = require('./resume-profile');
const { createAi } = require('./ai-providers');

const skippedJob = (jobId, question, { options = [], category = 'missing-info', title = 'Data Analyst', company = 'Acme', ts = '2026-09-28T10:00:00Z' } = {}) => ({
  type: 'job', ts, runId: 'r', mode: 'LIVE', jobId, title, company,
  outcome: { status: 'SKIPPED', reason: `human-needed: ${category}`, clicked: true,
    intervention: { category, question, options, missing: 'not in your profile', stage: 'application questionnaire' } },
});
const HISTORY = [
  skippedJob('1', 'What is your notice period?'),
  skippedJob('2', "What's your notice period"),                         // same question, different words
  skippedJob('3', 'WHAT IS YOUR NOTICE PERIOD ?', { company: 'Beta' }),
  skippedJob('4', 'Are you willing to work night shifts?', { options: ['Yes', 'No'], category: 'unanswerable-question' }),
  skippedJob('5', 'Are you willing to work night shifts?', { options: ['Yes', 'No', 'Maybe'] }), // different options → own group
  skippedJob('6', 'How many years have you managed a team of 20 people?'),
  skippedJob('7', 'Upload portfolio', { category: 'unsupported-form' }),  // not an inbox category
  { type: 'job', jobId: '8', outcome: { status: 'FAILED', reason: 'x' } },
  skippedJob('1', 'What is your notice period?'),                       // same job again → counted once
];

test('grouping: identical and near-identical questions group; different option sets do not; only inbox categories', () => {
  const inbox = Q.buildInbox(HISTORY);
  const byQ = inbox.map((g) => [g.question, g.options.length, g.jobs.map((j) => j.jobId)]);
  assert.deepStrictEqual(byQ, [
    ['What is your notice period?', 0, ['1', '2', '3']],
    ['Are you willing to work night shifts?', 2, ['4']],
    ['Are you willing to work night shifts?', 3, ['5']],
    ['How many years have you managed a team of 20 people?', 0, ['6']],
  ]);
  assert.ok(Q.similar('What is your notice period?', "what's your notice period"));
  assert.ok(!Q.similar('What is your notice period?', 'What is your current CTC?'));
});

test('saving an answer: validated, stored as "answered by you", group leaves the inbox; jobs already SKIPPED stay SKIPPED', () => {
  const inbox = Q.buildInbox(HISTORY);
  const shifts = inbox[1];
  assert.throws(() => Q.saveAnswer({}, shifts, 'Sometimes'), /one of the options/);
  assert.throws(() => Q.saveAnswer({}, inbox[0], '   '), /required/);
  let p = Q.saveAnswer({ name: 'Keep Me' }, inbox[0], '30 days');
  p = Q.saveAnswer(p, shifts, 'No');
  assert.strictEqual(p.name, 'Keep Me', 'the rest of the profile is untouched');
  assert.deepStrictEqual(p.answeredByYou.map((a) => [a.answer, a.source]), [['30 days', 'answered by you'], ['No', 'answered by you']]);
  const after = Q.buildInbox(HISTORY, p);
  assert.deepStrictEqual(after.map((g) => g.jobs[0].jobId), ['5', '6'], 'answered groups are no longer open');
  // the ledger is not touched by any of this: a SKIPPED job stays SKIPPED (and excluded)
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'ledger.jsonl');
  L.append({ jobId: '1', url: 'u', status: 'SKIPPED', reason: 'human-needed: missing-info' }, f);
  const before = fs.readFileSync(f, 'utf8');
  Q.saveAnswer({}, inbox[0], '30 days');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  assert.ok(L.excludedIds(L.load(f)).has('1'));
});

const noAi = () => createAi({ gemini: { apiKey: 'k', model: 'm' } }, { stateFile: null, sleep: async () => {},
  fetchImpl: async () => { throw new Error('the AI must not be called for this question'); } });

test('a saved answer is used by the answer engine for future jobs — through the same validation', async () => {
  const inbox = Q.buildInbox(HISTORY);
  const saved = Q.saveAnswer(Q.saveAnswer({}, inbox[0], '30 days'), inbox[1], 'No');
  const s = { answeredByYou: saved.answeredByYou, dontAnswer: [] };
  const a = await E.answer({ question: 'What is your notice period ?' }, { facts: {}, ai: noAi(), saved: s });
  assert.deepStrictEqual([a.status, a.answer, a.source, a.evidence], ['answered', '30 days', 'user', 'answered by you']);
  const b = await E.answer({ question: 'Are you willing to work night shifts?', options: ['Yes', 'No'] }, { facts: {}, ai: noAi(), saved: s });
  assert.deepStrictEqual([b.status, b.answer, b.source], ['answered', 'No', 'user']);
  // numeric question: "30 days" is not a number → the saved answer is NOT forced in; the chain decides
  const numericAi = createAi({ gemini: { apiKey: 'k', model: 'm' } }, { stateFile: null, sleep: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"answered","answer":"30","evidence":"answeredByYou"}' }] } }] }) }) });
  const c = await E.answer({ question: 'What is your notice period?', numeric: true }, { facts: {}, ai: numericAi, saved: s });
  assert.deepStrictEqual([c.status, c.answer, c.source], ['answered', '30', 'ai'], 'the AI saw the saved answer as a fact and returned a valid number');
});

test('saved answers reach the AI as facts (source "answered by you") for related questions', async () => {
  const calls = [];
  const ai = createAi({ gemini: { apiKey: 'k', model: 'm' } }, { stateFile: null, sleep: async () => {},
    fetchImpl: async (u, init) => { calls.push(init.body); return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"status":"unknown","missing":"x"}' }] } }] }) }; } });
  const s = { answeredByYou: [{ key: 'k', question: 'Do you have a two-wheeler?', options: [], answer: 'Yes, a scooter' }], dontAnswer: [] };
  await E.answer({ question: 'How will you commute to the office?' }, { facts: {}, ai, saved: s });
  assert.ok(calls[0].includes('Yes, a scooter'));
});

test('"Don\'t answer this" keeps skipping those jobs, without an AI call', async () => {
  const inbox = Q.buildInbox(HISTORY);
  const p = Q.dontAnswer({}, inbox[3]);
  assert.strictEqual(Q.buildInbox(HISTORY, p).length, 3, 'declined question leaves the inbox');
  const r = await E.answer({ question: 'How many years have you managed a team of 20 people?' }, { facts: {}, ai: noAi(), saved: { answeredByYou: [], dontAnswer: p.dontAnswer } });
  assert.deepStrictEqual([r.status, r.category], ['unknown', 'unanswerable-question'], '→ SKIPPED path, as before');
  // answering later replaces the "don't answer" choice, and forget() undoes either
  const p2 = Q.saveAnswer(p, inbox[3], 'None');
  assert.deepStrictEqual([p2.dontAnswer.length, p2.answeredByYou.length], [0, 1]);
  const p3 = Q.forget(p2, inbox[3].key);
  assert.strictEqual(Q.buildInbox(HISTORY, p3).length, 4, 'forgotten question returns to the inbox');
});

test('Setup pre-fill comes only from the resume profile', () => {
  const s = R.suggestPreferences({
    location: 'Pune, Maharashtra', skills: ['SQL', 'Power BI', 'Excel', 'Python', 'Tableau', 'DAX'],
    jobs: [{ title: 'Junior Analyst', end: '2021' }, { title: 'Data Analyst', end: 'Present' }, { title: 'data analyst', end: '2020' }],
  });
  assert.deepStrictEqual(s, { titles: ['Data Analyst', 'Junior Analyst'], keywords: ['SQL', 'Power BI', 'Excel', 'Python', 'Tableau'], locations: ['Pune'] });
  assert.deepStrictEqual(R.suggestPreferences(null), { titles: [], keywords: [], locations: [] });
});

test('the runner hands the saved answers to the answer engine', () => {
  const src = fs.readFileSync(path.join(__dirname, 'auto-apply-runner.js'), 'utf8');
  assert.ok(src.includes('saved: PROFILE ? { answeredByYou: PROFILE.answeredByYou || [], dontAnswer: PROFILE.dontAnswer || [] } : null'));
  const main = fs.readFileSync(path.join(__dirname, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes('resumeProfile.save(keepInbox(sanitizeProfile(p)))'), 'saving Setup never drops the inbox answers');
});
