/**
 * Job ↔ profile matching — ADVISORY ONLY. Nothing here can reject or skip a job; the
 * result is stored in history and shown in the app. (A threshold setting exists and
 * defaults to OFF; even when on it only flags `belowThreshold`, it does not gate.)
 *
 *   ruleMatch(job, facts, prefs)            deterministic, offline, always available
 *   aiMatch(job, facts, prefs, {ai})        the AI chain, only when the "AI matching" setting
 *                                           is on (default OFF); every skill it names is checked
 *                                           against the job text and the profile, and
 *                                           anything off-contract falls back to rules
 */

const low = (s) => String(s || '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(^|[^a-z0-9])${esc(low(term))}([^a-z0-9]|$)`).test(low(text));
const skillsOf = (facts) => [...new Set(String(facts.skills || '').split(',').map((s) => s.trim()).filter(Boolean))];
const jobText = (job) => [job.title, (job.tags || []).join(' , '), job.description].filter(Boolean).join('\n');

/** "1 - 4 years" → {min:1, max:4}; unknown → null */
function parseYears(s) {
  const m = String(s || '').match(/(\d+)\s*(?:-|to)\s*(\d+)\s*y/i);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}
function userYears(facts, prefs) {
  const n = Number(String(facts.totalExperience || '').match(/\d+(\.\d+)?/)?.[0]);
  if (Number.isFinite(n)) return n;
  return prefs?.experience?.min != null ? prefs.experience.min : null;
}
const decide = (score) => (score >= 70 ? 'good-match' : score >= 45 ? 'partial-match' : 'weak-match');

function ruleMatch(job, facts = {}, prefs = null) {
  const skills = skillsOf(facts);
  const text = jobText(job);
  if (!skills.length) {
    return { score: null, decision: 'unknown', matchedSkills: [], missingSkills: [], reasons: ['no skills in the profile to compare against'], source: 'rules' };
  }
  const matched = skills.filter((s) => mentions(text, s));
  // "missing" only from the job's own explicit skill tags — never guessed from prose
  const missing = (job.tags || []).filter((t) => !skills.some((s) => low(s) === low(t) || mentions(t, s)));
  const skillFit = matched.length / Math.max(1, matched.length + missing.length);
  const reasons = [`${matched.length} of your skills appear in the job; ${missing.length} of its listed skills are not in your profile`];
  let expFit = 0.5;
  const range = parseYears(job.experience), yrs = userYears(facts, prefs);
  if (range && yrs != null) {
    expFit = yrs >= range.min - 1 && yrs <= range.max + 1 ? 1 : 0;
    reasons.push(`experience asked ${range.min}–${range.max} yrs, you have ${yrs}: ${expFit ? 'fits' : 'outside the range'}`);
  } else reasons.push('experience fit unknown');
  let locFit = 0.5;
  if (prefs && !prefs.anyLocation && prefs.locations.length && job.location) {
    locFit = prefs.locations.some((l) => low(job.location).includes(low(l))) ? 1 : 0;
    reasons.push(`location ${job.location}: ${locFit ? 'preferred' : 'not in your preferred locations'}`);
  }
  const score = Math.round(100 * (0.7 * skillFit + 0.2 * expFit + 0.1 * locFit));
  return { score, decision: decide(score), matchedSkills: matched, missingSkills: missing, reasons, source: 'rules' };
}

const PROMPT = [
  'Assess how well the CANDIDATE fits the JOB. Use only the data given; do not assume skills or experience.',
  'Return only JSON: {"score":0-100,"matchedSkills":[],"missingSkills":[],"reasons":[],"decision":"good-match"|"partial-match"|"weak-match"}',
  'matchedSkills: skills that appear in BOTH the candidate data and the job. missingSkills: skills the job asks for that the candidate data does not show.',
  'reasons: at most 5 short factual sentences.',
].join('\n');

/** AI match with every claim checked. Falls back to the rule result on anything off-contract. */
async function aiMatch(job, facts = {}, prefs = null, opts = {}) {
  const base = ruleMatch(job, facts, prefs);
  if (!opts.ai) return base;
  const candidate = { skills: facts.skills, employmentHistory: facts.employmentHistory, education: facts.education,
    certifications: facts.certifications, projects: facts.projects, totalExperience: facts.totalExperience, currentRole: facts.currentRole };
  const res = await opts.ai.askJson(`${PROMPT}\n\n${JSON.stringify({ CANDIDATE: candidate, JOB: job, PREFERENCES: prefs ? { locations: prefs.locations, workModes: prefs.workModes, experience: prefs.experience, salary: prefs.salary } : {} })}`, { purpose: 'match' });
  if (!res.ok) return { ...base, aiError: res.error };
  const o = res.json || {};
  const score = Number(o.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ...base, aiError: 'AI score out of range' };
  const text = jobText(job);
  const cand = JSON.stringify(candidate);
  const matched = (Array.isArray(o.matchedSkills) ? o.matchedSkills : []).map(String).filter((s) => mentions(text, s) && mentions(cand, s));
  const missing = (Array.isArray(o.missingSkills) ? o.missingSkills : []).map(String).filter((s) => mentions(text, s) && !mentions(cand, s));
  const reasons = (Array.isArray(o.reasons) ? o.reasons : []).map(String).filter(Boolean).slice(0, 5);
  const decision = ['good-match', 'partial-match', 'weak-match'].includes(o.decision) ? o.decision : decide(score);
  return { score: Math.round(score), decision, matchedSkills: matched, missingSkills: missing, reasons, source: 'ai', ai: { provider: res.provider, model: res.model }, rules: { score: base.score, decision: base.decision } };
}

/** The threshold only FLAGS (advisory); it never returns a reject/skip decision. */
function applyThreshold(match, prefs) {
  const t = prefs?.matching;
  if (!t || !t.thresholdEnabled || match.score == null) return { ...match, belowThreshold: false };
  return { ...match, threshold: t.threshold, belowThreshold: match.score < t.threshold };
}

module.exports = { ruleMatch, aiMatch, applyThreshold, parseYears };
