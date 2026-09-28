/**
 * Job ↔ profile matching. The score is stored in history and shown in the app; the
 * runner's low-match gate (Settings > Advanced threshold, default 50 %, can be Off)
 * skips jobs whose score is below it — after the Apply-button check, never before.
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

/**
 * Skill equivalents: different spellings of the same skill count as one
 * (Excel ≈ Advanced Excel ≈ Microsoft Excel, MySQL ≈ SQL, …). Kept deliberately small.
 */
const ALIASES = [
  ['excel', ['excel', 'ms excel', 'ms-excel', 'microsoft excel', 'advanced excel', 'advance excel', 'advanced ms excel', 'excel vba']],
  ['sql', ['sql', 'mysql', 'my sql', 'postgresql', 'postgres', 'ms sql', 'mssql', 'sql server', 'ms sql server', 't-sql', 'tsql', 'pl/sql', 'plsql', 'oracle sql', 'sql queries']],
  ['power bi', ['power bi', 'powerbi', 'power-bi', 'ms power bi', 'microsoft power bi', 'power bi desktop']],
  ['python', ['python', 'python3', 'python 3']],
  ['tableau', ['tableau', 'tableau desktop']],
  ['data visualization', ['data visualization', 'data visualisation']],
  ['data analysis', ['data analysis', 'data analytics']],
  ['statistics', ['statistics', 'statistical analysis']],
  ['machine learning', ['machine learning', 'ml']],
  ['google sheets', ['google sheets', 'gsheets', 'google spreadsheets']],
];
/** Tags that say nothing about fit: never counted as matched or missing. */
const GENERIC = new Set(['coding', 'consulting', 'communication', 'communication skills', 'verbal communication', 'written communication',
  'time management', 'teamwork', 'team work', 'team player', 'problem solving', 'analytical', 'analytical skills', 'analytical thinking',
  'leadership', 'management', 'english', 'fluent english', 'interpersonal skills', 'presentation', 'presentation skills', 'hard working',
  'self motivated', 'attention to detail', 'multitasking', 'fresher', 'freshers', 'b.tech fresher', 'any graduate', 'graduate',
  'computer science', 'computer sceince']);
const norm = (s) => low(s).replace(/[^a-z0-9+#/.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
/** Canonical form of a skill/tag (alias group name, else the normalised text). */
function canon(s) {
  const n = norm(s);
  for (const [name, list] of ALIASES) if (list.includes(n)) return name;
  return n;
}
const aliasesOf = (skill) => { const c = canon(skill); const g = ALIASES.find(([n]) => n === c); return g ? g[1] : [norm(skill)]; };
const isGeneric = (t) => GENERIC.has(norm(t));

function ruleMatch(job, facts = {}, prefs = null) {
  const skills = skillsOf(facts);
  const text = jobText(job);
  if (!skills.length) {
    return { score: null, decision: 'unknown', matchedSkills: [], missingSkills: [], reasons: ['no skills in the profile to compare against'], source: 'rules' };
  }
  const tags = (job.tags || []).filter((t) => !isGeneric(t));
  const tagCanon = new Set(tags.map(canon));
  const mine = new Set(skills.map(canon));
  // matched: one of your skills (or an equivalent spelling) is a job tag or appears in its text
  const matched = skills.filter((s) => tagCanon.has(canon(s)) || aliasesOf(s).some((a) => mentions(text, a)));
  // "missing" only from the job's own explicit, non-generic skill tags — never guessed from prose
  const missing = tags.filter((t) => !mine.has(canon(t)));
  const skillFit = matched.length / Math.max(1, matched.length + missing.length);
  const reasons = [`${matched.length} of your skills appear in the job; ${missing.length} of its listed skills are not in your profile`];
  let expFit = 0.5;
  const range = parseYears(job.experience), yrs = userYears(facts, prefs);
  if (range && yrs != null) {
    expFit = yrs >= range.min - 1 && yrs <= range.max + 1 ? 1 : 0;
    reasons.push(`experience asked ${range.min}–${range.max} yrs, you have ${yrs}: ${expFit ? 'fits' : 'outside the range'}`);
  } else reasons.push('experience fit unknown');
  let locFit = 0.5;
  const lf = prefs ? require('./preferences').locationFilter(prefs) : null;
  const remoteOk = !!(prefs && (prefs.workModes || []).includes('remote'));
  if (job.location && remoteOk && /remote|work from home/i.test(job.location)) {
    locFit = 1; // Remote is a fit whenever you selected Remote
    reasons.push(`location ${job.location}: remote, and you accept remote`);
  } else if (lf && job.location) {
    locFit = lf.locations.some((l) => low(job.location).includes(low(l))) ? 1 : 0;
    reasons.push(`location ${job.location}: ${locFit ? 'one of your cities' : 'not one of your cities'}`);
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
  const res = await opts.ai.askJson(`${PROMPT}\n\n${JSON.stringify({ CANDIDATE: candidate, JOB: job, PREFERENCES: prefs ? { cities: (prefs.cities || []).map((g) => (require('./naukri-filters').cityByGid(g) || {}).name), workModes: prefs.workModes, experience: prefs.experience, salaryRanges: prefs.salaryRanges } : {} })}`, { purpose: 'match' });
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

/**
 * Mark a match below the user's threshold. The runner's low-match gate (onCheckMatch)
 * turns `belowThreshold` into "don't apply → SKIPPED low-match". Off, or an unknown
 * score (no profile skills), never marks.
 */
function applyThreshold(match, prefs) {
  const t = prefs?.matching;
  if (!t || !t.thresholdEnabled || match.score == null) return { ...match, belowThreshold: false };
  return { ...match, threshold: t.threshold, belowThreshold: match.score < t.threshold };
}

module.exports = { ruleMatch, aiMatch, applyThreshold, parseYears, canon, isGeneric };
