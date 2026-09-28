/**
 * Answers application questions in Node — the page never holds an API key or the CV.
 *
 *   answer({question, options, numeric, job}, {facts, ai})
 *     → {status: 'answered', answer, evidence, source, ai?}
 *     | {status: 'unknown', category, missing}        (never a made-up fallback)
 *
 * Order: direct factual lookup from the user's own data (only non-empty values), then
 * the AI chain (ai-providers.js: Gemini, then Groq) with an explicit "unknown" option.
 * Every AI answer — whichever provider produced it — goes through validate(): options
 * must be returned verbatim, numeric answers must be numbers, no evidence = unknown.
 *
 * Categories: unanswerable-question · missing-info (→ SKIPPED) · ai-error (transient,
 * → FAILED, retried later) · ai-daily-limit (no provider left today → the run stops).
 *
 *   node answer-engine.js --check      test Gemini and Groq separately
 */
const { GEMINI_DEFAULT_MODEL, createAi, aiConfig } = require('./ai-providers');
const { findSaved } = require('./question-inbox');
const DEFAULT_MODEL = GEMINI_DEFAULT_MODEL;
const DEFAULT_WORK_AUTH = 'Authorized to work in my country of residence.'; // config.js default, not user data

/**
 * The user's own facts, from the .env CV. Derived sentences config.js makes up
 * (remoteOk, relocate, startDate, the WORK_AUTH default) are NOT facts and are dropped.
 */
function buildFacts(cv = {}) {
  const f = {
    name: cv.name, email: cv.email, phone: cv.phone, location: cv.location,
    currentRole: cv.currentRole, currentCompany: cv.company, education: cv.education,
    totalExperience: cv.yearsOfExperience, skills: cv.skills,
    highlights: (cv.highlights || []).filter(Boolean),
    noticePeriod: cv.noticePeriod, currentCTC_lakhs: cv.currentCTC, expectedCTC_lakhs: cv.expectedCTC,
    dateOfBirth: cv.dob, gender: cv.gender,
    workAuthorization: cv.workAuth === DEFAULT_WORK_AUTH ? '' : cv.workAuth,
    linkedin: cv.linkedin, github: cv.github, portfolio: cv.portfolio,
  };
  for (const k of Object.keys(f)) if (f[k] == null || f[k] === '' || (Array.isArray(f[k]) && !f[k].length)) delete f[k];
  return f;
}

/**
 * Only the facts a question needs go to the AI. Professional facts (skills, history,
 * education, …) are the default context; contact, personal, pay, notice and location
 * facts are included only when the question is about them.
 */
const GROUPS = [
  [['email', 'phone'], /e-?mail|phone|mobile|contact/i],
  [['dateOfBirth'], /birth|dob|age/i],
  [['gender'], /gender|sex/i],
  [['currentCTC_lakhs', 'expectedCTC_lakhs'], /ctc|salary|compensation|pay|package|lakh|lpa/i],
  [['noticePeriod'], /notice|join|start|availab/i],
  [['location', 'willingToRelocate', 'preferredWorkModes', 'preferredLocations'], /locat|relocat|city|based|remote|hybrid|office|on-?site|commute|shift to|move to/i],
  [['workAuthorization'], /visa|sponsor|authori[sz]|citizen|right to work|permit/i],
  [['name'], /name/i],
];
const GATED = new Set(GROUPS.flatMap(([keys]) => keys));
function relevantFacts(facts, question) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) if (!GATED.has(k)) out[k] = v; // professional context
  for (const [keys, re] of GROUPS) if (re.test(question)) for (const k of keys) if (k in facts) out[k] = facts[k];
  return out;
}

const NUMBER = /^\d+(\.\d+)?$/;
const looksNumeric = (q) => /\bhow many\b|\bnumber of\b|\bin (years|months|days|lakhs?|lpa)\b|\byears of (work |professional |total |relevant )?experience\b|\btotal experience\b/i.test(q);

/** Direct lookups for unambiguous factual questions. Returns null when not a clear fact. */
function factLookup(question, facts, { numeric }) {
  const q = String(question || '');
  const skillSpecific = /\b(in|with|on|using)\s+[a-z]/i.test(q.replace(/\bin (years|months|days|lakhs?|lpa)\b/ig, ''));
  const rules = [
    [/\be-?mail\b/i, 'email'],
    [/\b(phone|mobile|contact) (number|no\.?)\b|\bmobile\b|^\s*phone\b/i, 'phone'],
    [/^\s*(your |full |candidate )?name\s*\??\s*$|\bwhat is your (full )?name\b/i, 'name'],
    [/\bnotice period\b/i, 'noticePeriod'],
    [/\bcurrent (ctc|salary|compensation|annual)/i, 'currentCTC_lakhs'],
    [/\b(expected|desired) (ctc|salary|compensation)/i, 'expectedCTC_lakhs'],
    [/\bcurrent (company|employer|organi[sz]ation)\b/i, 'currentCompany'],
    [/\bcurrent (location|city)\b|\bwhere are you (currently )?(based|located)\b/i, 'location'],
    [/\blinkedin\b/i, 'linkedin'],
    [/\bgithub\b/i, 'github'],
    [/\bportfolio\b/i, 'portfolio'],
  ];
  if (!skillSpecific && /\b(total|overall) (work )?experience\b|\bhow many years of (work |professional )?experience do you have\??$/i.test(q)) {
    rules.unshift([/./, 'totalExperience']);
  }
  for (const [re, key] of rules) {
    if (!re.test(q) || !facts[key]) continue;
    let value = String(facts[key]).trim();
    // rupee / monthly figures are not the lakhs-per-annum value we hold
    if (/CTC_lakhs$/.test(key) && /rupees|\binr\b|per month|monthly/i.test(q)) return null;
    if (numeric) {
      const m = value.match(/^\s*(\d+(?:\.\d+)?)\s*(years?|yrs?|days?|months?|lakhs?|lpa)?\s*$/i);
      if (!m) return null; // e.g. a range "18-25" — not ours to collapse into one number
      const unitAsked = (q.match(/\bin (years|months|days|lakhs?|lpa)\b/i) || [])[1];
      if (unitAsked && m[2] && unitAsked[0].toLowerCase() !== m[2][0].toLowerCase()) return null; // unit mismatch
      value = m[1];
    }
    return { status: 'answered', answer: value, evidence: `profile.${key}`, source: 'fact' };
  }
  return null;
}

function buildPrompt({ question, options, numeric, job }, facts) {
  return [
    'You fill in ONE job-application question on behalf of the candidate described in FACTS.',
    'Rules:',
    '- Use ONLY FACTS and JOB. Never invent or estimate personal details, numbers, dates, employers, skills, preferences or experience.',
    '- If FACTS do not clearly establish the answer, return status "unknown" and say in "missing" exactly what information is needed.',
    '- If OPTIONS is non-empty, "answer" must be exactly one of OPTIONS, copied character for character.',
    '- If NUMERIC is true, "answer" must be only a number (digits, optional decimal point).',
    '- Motivation questions (e.g. why this role) may be answered in 1-3 first-person sentences grounded in FACTS and JOB.',
    '- "evidence" must name the FACTS fields (and JOB fields) the answer is based on.',
    'Return only JSON: {"status":"answered"|"unknown","answer":"...","evidence":"...","missing":"..."}',
    '',
    JSON.stringify({ QUESTION: question, OPTIONS: options || [], NUMERIC: !!numeric, JOB: job || {}, FACTS: facts }),
  ].join('\n');
}

/**
 * One question to the AI chain. Never throws; failures come back as unknown with
 * ai-error (transient) or ai-daily-limit (nothing usable today), never a fallback answer.
 */
async function askAi(q, facts, ai) {
  if (!ai) return { status: 'unknown', category: 'ai-error', missing: 'no AI provider configured' };
  const res = await ai.askJson(buildPrompt(q, facts), { purpose: 'answer' });
  if (!res.ok) return { status: 'unknown', category: res.kind === 'daily-limit' ? 'ai-daily-limit' : 'ai-error', missing: res.error };
  const v = validate(res.json, q); // the SAME validation for every provider
  return v.status === 'answered' ? { ...v, ai: { provider: res.provider, model: res.model } } : v;
}

/** Enforce the contract on whatever the model said. Anything off-contract is unknown. */
function validate(out, { options = [], numeric = false } = {}) {
  if (!out || typeof out !== 'object') return { status: 'unknown', category: 'ai-error', missing: 'empty AI response' };
  if (out.status === 'unknown') {
    const missing = String(out.missing || '').trim();
    return { status: 'unknown', category: missing ? 'missing-info' : 'unanswerable-question', missing };
  }
  if (out.status !== 'answered') return { status: 'unknown', category: 'unanswerable-question', missing: `invalid AI status "${out.status}"` };
  const answer = String(out.answer ?? '').trim();
  const evidence = String(out.evidence ?? '').trim();
  if (!answer || answer.length > 1500) return { status: 'unknown', category: 'unanswerable-question', missing: 'AI gave no usable answer' };
  if (!evidence) return { status: 'unknown', category: 'unanswerable-question', missing: 'AI answer had no evidence from the profile' };
  if (options.length && !options.includes(answer)) {
    return { status: 'unknown', category: 'unanswerable-question', missing: `AI answer "${answer.slice(0, 60)}" is not one of the options` };
  }
  if (numeric && !NUMBER.test(answer)) {
    return { status: 'unknown', category: 'unanswerable-question', missing: `AI answer "${answer.slice(0, 60)}" is not a number` };
  }
  return { status: 'answered', answer, evidence, source: 'ai' };
}

/**
 * Full pipeline for one question from the page. `saved` = the user's inbox choices
 * ({answeredByYou, dontAnswer} from profile.json): "don't answer" → unknown right away
 * (the job keeps being skipped, no AI call); a saved answer is used when the SAME
 * validation as every AI answer accepts it for this question; saved answers are also
 * given to the AI as facts (source "answered by you").
 */
async function answer(q, { facts = {}, ai = null, saved = null } = {}) {
  const question = String(q?.question || '').trim();
  const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!question) return { status: 'unknown', category: 'unexpected-behaviour', missing: 'no question text could be read' };
  const numeric = !!q?.numeric || (!options.length && looksNumeric(question));
  const req = { question, options, numeric, job: q?.job || {} };
  const mine = saved ? findSaved(question, options, saved) : null;
  if (mine && mine.type === 'dont') return { status: 'unknown', category: 'unanswerable-question', missing: 'you chose not to answer this question' };
  if (mine && mine.type === 'answer') {
    const v = validate({ status: 'answered', answer: mine.entry.answer, evidence: 'answered by you' }, req);
    if (v.status === 'answered') return { ...v, source: 'user' };
  }
  const fact = factLookup(question, facts, { numeric });
  if (fact && (!options.length || options.includes(fact.answer))) return fact;
  const withSaved = saved && (saved.answeredByYou || []).length
    ? { ...facts, answeredByYou: saved.answeredByYou.map((a) => ({ question: a.question, answer: a.answer })) } : facts;
  return askAi(req, relevantFacts(withSaved, question), ai);
}

module.exports = { DEFAULT_MODEL, buildFacts, relevantFacts, factLookup, validate, askAi, answer, buildPrompt };

// node answer-engine.js --check [--models] : each provider tested on its own (no fallback).
// Models are listed when the model is missing or 404s, or always with --models; a failed
// listing prints its actual error.
if (require.main === module && process.argv.includes('--check')) {
  const { formatCheck } = require('./ai-providers');
  const ai = createAi(aiConfig(require('./config')));
  (async () => {
    const r = await ai.check();
    if (process.argv.includes('--models')) {
      for (const name of Object.keys(r)) {
        if (r[name].models || r[name].listError || /is not set$/.test(r[name].reason) && !/MODEL/.test(r[name].reason)) continue;
        const l = await ai.listModels(name);
        if (l.ok) r[name].models = l.models; else r[name].listError = l.error;
      }
    }
    const { lines, working } = formatCheck(r);
    for (const l of lines) console.log(l);
    process.exit(working ? 0 : 1);
  })();
}
