/** node --test job-match.test.js — advisory matching; Gemini mocked. */
const test = require('node:test');
const assert = require('assert');
const M = require('./job-match');
const P = require('./preferences');

const job = { title: 'Data Analyst', location: 'Pune', experience: '1 - 4 years', tags: ['SQL', 'Power BI', 'Tableau'],
  description: 'We need SQL and Power BI dashboards. Tableau is a plus.' };
const facts = { skills: 'SQL, Power BI, Excel', totalExperience: '3' };
const prefs = P.normalize({ locations: ['Pune'], titles: ['Data Analyst'] });
const gemini = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), headers: { get: () => null } });
const { createAi } = require('./ai-providers');
const chain = (fetchImpl) => createAi({ gemini: { apiKey: 'k', model: 'm' } }, { fetchImpl, stateFile: null, sleep: async () => {} });

test('rules: matched/missing come only from real text; score and reasons', () => {
  const m = M.ruleMatch(job, facts, prefs);
  assert.deepStrictEqual(m.matchedSkills, ['SQL', 'Power BI']);
  assert.deepStrictEqual(m.missingSkills, ['Tableau'], 'missing = the job\'s own tags not in the profile');
  assert.strictEqual(m.source, 'rules');
  assert.ok(m.score >= 60 && m.score <= 100, `score ${m.score}`);
  assert.ok(m.reasons.some((r) => /fits/.test(r)));
});

test('rules: no profile skills → unknown, not a guess', () => {
  const m = M.ruleMatch(job, {}, null);
  assert.strictEqual(m.score, null);
  assert.strictEqual(m.decision, 'unknown');
});

test('AI: invented skills are removed; off-contract output falls back to rules', async () => {
  const m = await M.aiMatch(job, facts, prefs, { ai: chain(gemini({
    score: 88, decision: 'good-match', reasons: ['Strong SQL'],
    matchedSkills: ['SQL', 'Kubernetes'], // Kubernetes is in neither text
    missingSkills: ['Tableau', 'Excel'],  // Excel is not asked by the job AND the candidate has it
  })) });
  assert.strictEqual(m.source, 'ai');
  assert.strictEqual(m.score, 88);
  assert.deepStrictEqual(m.matchedSkills, ['SQL']);
  assert.deepStrictEqual(m.missingSkills, ['Tableau']);
  const bad = await M.aiMatch(job, facts, prefs, { ai: chain(gemini({ score: 140 })) });
  assert.strictEqual(bad.source, 'rules');
  assert.ok(bad.aiError);
  const down = await M.aiMatch(job, facts, prefs, { ai: chain(async () => { throw new Error('offline'); }) });
  assert.strictEqual(down.source, 'rules');
});

test('AI matching defaults OFF; threshold defaults ON at 50%', () => {
  assert.deepStrictEqual(P.normalize({}).matching, { aiEnabled: false, thresholdEnabled: true, threshold: 50 }, 'AI matching off; low-match gate on at 50%');
  const runner = require('fs').readFileSync(require('path').join(__dirname, 'auto-apply-runner.js'), 'utf8');
  assert.ok(runner.includes('if (AI && MATCH_PREFS.matching.aiEnabled) m = await jobMatch.aiMatch('), 'no AI call for matching unless the setting is on');
  const low = { score: 30, decision: 'weak-match' };
  assert.strictEqual(M.applyThreshold(low, P.normalize({ matching: { thresholdEnabled: false } })).belowThreshold, false, 'off → no flag');
  const flagged = M.applyThreshold(low, P.normalize({ matching: { thresholdEnabled: true, threshold: 50 } }));
  assert.strictEqual(flagged.belowThreshold, true);
  assert.ok(!['skip', 'reject'].includes(flagged.decision));
});

test('the runner gates only below the threshold, and only after the Apply-button check', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'auto-apply-runner.js'), 'utf8');
  const gate = src.slice(src.indexOf('async function onCheckMatch'), src.indexOf('async function onCheckMatch') + 2000);
  assert.ok(gate.includes('if (!m.belowThreshold) return { ok: true'), 'passes unless below the threshold');
  assert.ok(gate.includes("reason: `low-match: ${m.score}% (${m.source === 'ai' ? 'ai' : 'rules'})`"));
  assert.ok(!/run.record|finishJob/.test(gate), 'the gate decides; the normal report path records');
  const page = require('fs').readFileSync(require('path').join(__dirname, 'naukri-auto-apply.js'), 'utf8');
  const i = (t) => page.indexOf(t);
  assert.ok(i("if (applyBtn === 'external')") < i('const gate = await checkMatch(job);'), 'company-site jobs never reach the match');
  assert.ok(i("if (applyBtn === 'no-apply')") < i('const gate = await checkMatch(job);'), 'no-button jobs never reach the match');
  assert.ok(i('const gate = await checkMatch(job);') < i('if (CONFIG.DRY_RUN) {'), 'the gate also applies in DRY runs');
});
test('experience ranges parse', () => {
  assert.deepStrictEqual(M.parseYears('1 - 4 years'), { min: 1, max: 4 });
  assert.deepStrictEqual(M.parseYears('3 to 8 Yrs'), { min: 3, max: 8 });
  assert.strictEqual(M.parseYears('Not Disclosed'), null);
});
