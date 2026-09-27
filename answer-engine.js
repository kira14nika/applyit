/**
 * Answers application questions in Node — the page never holds the API key or the CV.
 *
 *   answer({question, options, numeric, job}, {facts, apiKey, model, fetchImpl})
 *     → {status: 'answered', answer, evidence, source}
 *     | {status: 'unknown', category, missing}        (never a made-up fallback)
 *
 * Order: direct factual lookup from the user's own data (only non-empty values), then
 * Gemini with an explicit "unknown" option. Every Gemini answer is validated here:
 * options must be returned verbatim, numeric answers must be numbers, and an answer
 * without evidence is treated as unknown.
 *
 * Categories: unanswerable-question · missing-info · ai-error (transient: the runner
 * records FAILED, not SKIPPED, so the job is retried later).
 *
 *   node answer-engine.js --check      verify GEMINI_KEY + GEMINI_MODEL actually respond
 */
const DEFAULT_MODEL = 'gemini-2.5-flash';
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

/** Contact/identity details go to the model only when the question is about them. */
const SENSITIVE = { email: /e-?mail/i, phone: /phone|mobile|contact/i, dateOfBirth: /birth|dob|\bage\b/i, gender: /gender|sex\b/i };
function relevantFacts(facts, question) {
  const out = { ...facts };
  for (const [k, re] of Object.entries(SENSITIVE)) if (!re.test(question)) delete out[k];
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
 * One Gemini JSON call (shared by answers, resume extraction and matching).
 * → {ok: true, json} | {ok: false, error}. Never throws. Key in a header, never the URL.
 */
async function askJson(prompt, { apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  if (!apiKey) return { ok: false, error: 'GEMINI_KEY is empty' };
  let text;
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Gemini HTTP ${res.status}: ${String(data?.error?.message || '').slice(0, 160)}` };
    text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  } catch (e) {
    return { ok: false, error: `Gemini call failed: ${String(e.message || e).slice(0, 160)}` };
  }
  try { return { ok: true, json: JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')) }; }
  catch (e) { return { ok: false, error: 'Gemini returned non-JSON' }; }
}

/** One question to Gemini. Never throws; errors come back as unknown/ai-error. */
async function askGemini(q, facts, opts = {}) {
  if (!opts.apiKey) return { status: 'unknown', category: 'unanswerable-question', missing: 'AI answering is not configured (GEMINI_KEY is empty)' };
  const res = await askJson(buildPrompt(q, facts), opts);
  if (!res.ok) return { status: 'unknown', category: 'ai-error', missing: res.error };
  return validate(res.json, q);
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

/** Full pipeline for one question from the page. */
async function answer(q, { facts = {}, apiKey = '', model = DEFAULT_MODEL, fetchImpl } = {}) {
  const question = String(q?.question || '').trim();
  const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!question) return { status: 'unknown', category: 'unexpected-behaviour', missing: 'no question text could be read' };
  const numeric = !!q?.numeric || (!options.length && looksNumeric(question));
  const req = { question, options, numeric, job: q?.job || {} };
  const fact = factLookup(question, facts, { numeric });
  if (fact && (!options.length || options.includes(fact.answer))) return fact;
  return askGemini(req, relevantFacts(facts, question), { apiKey, model, fetchImpl });
}

module.exports = { DEFAULT_MODEL, buildFacts, relevantFacts, factLookup, validate, askJson, askGemini, answer, buildPrompt };

// node answer-engine.js --check : one tiny real call to prove the key + model respond
if (require.main === module && process.argv.includes('--check')) {
  const { geminiKey, geminiModel } = require('./config');
  const model = geminiModel || DEFAULT_MODEL;
  answer({ question: 'What is 2 + 2? (This is a connectivity check; answer from JOB.)', numeric: true, job: { note: '2 + 2 = 4' } },
    { facts: {}, apiKey: geminiKey, model })
    .then((r) => {
      console.log(`model ${model}:`, JSON.stringify(r));
      process.exit(r.category === 'ai-error' || (!geminiKey) ? 1 : 0);
    });
}
