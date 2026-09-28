/**
 * Resume → profile.json. Everything here runs in Node.
 *
 *   extractPdfText(file)                       local text extraction (pdfjs-dist)
 *   buildProfile(text, {ai})                   the AI chain (Gemini → Groq) structures it, then EVERY value
 *                                              is checked against the resume text and dropped
 *                                              if it does not literally appear there
 *   load() / save(profile)                     profile.json (git-ignored)
 *   factsFromProfile(profile, cv, prefs)       what the answer engine may use
 *
 * "No guessed fields": the grounding filter keeps a value only if its text is found in
 * the resume (case/space-insensitive). Anything the model inferred, normalised into a
 * different wording, or made up is removed. The user reviews and edits the result; the
 * separate `userProvided` block holds what a resume can't say (notice period, CTC, …).
 */
const fs = require('fs');
const path = require('path');

const PROFILE = path.join(__dirname, 'profile.json');

async function extractPdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    let line = '', out = [], lastY = null;
    for (const it of c.items) {
      const y = it.transform ? Math.round(it.transform[5]) : lastY;
      if (lastY !== null && y !== lastY && line.trim()) { out.push(line.trim()); line = ''; }
      line += (line && !line.endsWith(' ') && it.str && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      if (it.hasEOL) { out.push(line.trim()); line = ''; }
      lastY = y;
    }
    if (line.trim()) out.push(line.trim());
    pages.push(out.filter(Boolean).join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim();
}

const norm = (s) => String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
/** Is this value literally in the resume? Phone numbers compare digits only. */
function grounded(value, text, { phone = false } = {}) {
  if (value == null || value === '') return false;
  if (phone) { const d = digits(value); return d.length >= 7 && digits(text).includes(d); }
  return norm(text).includes(norm(value));
}

const EMPTY = () => ({
  name: '', email: '', phone: '', location: '', headline: '',
  skills: [], tools: [], languages: [],
  jobs: [], education: [], certifications: [], projects: [],
});

/** Keep only values found in the resume text. Returns {profile, dropped[]}. */
function groundProfile(raw, text) {
  const p = EMPTY();
  const dropped = [];
  const keep = (label, v, opts) => { if (grounded(v, text, opts)) return String(v).trim(); if (v) dropped.push(`${label}: ${v}`); return ''; };
  p.name = keep('name', raw.name);
  p.email = keep('email', raw.email);
  p.phone = keep('phone', raw.phone, { phone: true });
  p.location = keep('location', raw.location);
  p.headline = keep('headline', raw.headline);
  for (const k of ['skills', 'tools', 'languages', 'certifications']) {
    p[k] = [...new Set((Array.isArray(raw[k]) ? raw[k] : []).map((v) => keep(k, v)).filter(Boolean))];
  }
  for (const j of Array.isArray(raw.jobs) ? raw.jobs : []) {
    const job = { title: keep('job title', j.title), employer: keep('employer', j.employer), start: keep('job start', j.start), end: keep('job end', j.end) };
    if (/^(present|current|now|till date)$/i.test(String(j.end || '').trim()) && grounded(j.end, text)) job.end = String(j.end).trim();
    if (job.title || job.employer) p.jobs.push(job); else dropped.push(`job: ${j.title || ''} @ ${j.employer || ''}`);
  }
  for (const e of Array.isArray(raw.education) ? raw.education : []) {
    const ed = { degree: keep('degree', e.degree), institution: keep('institution', e.institution), year: keep('education year', e.year) };
    if (ed.degree || ed.institution) p.education.push(ed);
  }
  for (const pr of Array.isArray(raw.projects) ? raw.projects : []) {
    const name = keep('project', pr.name);
    // a description is a summary, so it cannot be matched verbatim — keep only its grounded sentences
    const desc = String(pr.description || '').split(/(?<=[.!?])\s+/).filter((s) => grounded(s.replace(/[.!?]$/, ''), text)).join(' ');
    if (name) p.projects.push({ name, description: desc });
  }
  return { profile: p, dropped };
}

const PROMPT = [
  'Extract the candidate profile from the RESUME TEXT below.',
  'Rules: copy values EXACTLY as they are written in the resume (same words, same spelling, same date format).',
  'Do not infer, summarise, translate, normalise or guess. If something is not in the text, use "" or [].',
  'Return only JSON with this shape:',
  '{"name":"","email":"","phone":"","location":"","headline":"","skills":[],"tools":[],"languages":[],',
  '"jobs":[{"title":"","employer":"","start":"","end":""}],"education":[{"degree":"","institution":"","year":""}],',
  '"certifications":[],"projects":[{"name":"","description":""}]}',
].join('\n');

/**
 * Structure resume text into a grounded profile. Without an API key (or on any AI
 * error) only the literal email/phone patterns found in the text are filled — the
 * user completes the rest by hand. Never throws.
 */
async function buildProfile(text, { ai = null } = {}) {
  const base = { ...EMPTY(), email: (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0],
    phone: (text.match(/\+?\d[\d\s-]{8,}\d/) || [''])[0].trim() };
  if (!ai) return { profile: base, dropped: [], ai: 'not configured (no AI key) — fill the profile in by hand' };
  const res = await ai.askJson(`${PROMPT}\n\nRESUME TEXT:\n${text.slice(0, 30000)}`, { purpose: 'resume-extraction' });
  if (!res.ok) return { profile: base, dropped: [], ai: `AI error: ${res.error}` };
  // the grounding filter applies to every provider's output alike
  const { profile, dropped } = groundProfile(res.json || {}, text);
  if (!profile.email) profile.email = base.email;
  if (!profile.phone) profile.phone = base.phone;
  return { profile, dropped, ai: `ok (${res.provider} ${res.model})` };
}

function load(file = PROFILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function save(profile, file = PROFILE) {
  const clean = { ...EMPTY(), ...profile, savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(clean, null, 2));
  return clean;
}

/**
 * Application facts a resume usually doesn't contain. Entered in Setup (stored in
 * profile.json `userProvided`); for these fields ONLY, the .env value is used when Setup
 * leaves them empty. `env` names the config.js CV field; `fact` is the answer-engine key.
 * Relocation and work modes come from preferences.json and have no .env fallback — the
 * .env "relocate"/"remoteOk" values are sentences config.js invents, not user data.
 */
const DEFAULT_WORK_AUTH = 'Authorized to work in my country of residence.'; // config.js default, not user data
const APP_FACTS = [
  { key: 'noticePeriod', label: 'Notice period', env: 'noticePeriod', fact: 'noticePeriod' },
  { key: 'currentCTC', label: 'Current CTC (lakhs/yr)', env: 'currentCTC', fact: 'currentCTC_lakhs' },
  { key: 'expectedCTC', label: 'Expected CTC (lakhs/yr)', env: 'expectedCTC', fact: 'expectedCTC_lakhs' },
  { key: 'dateOfBirth', label: 'Date of birth', env: 'dob', fact: 'dateOfBirth' },
  { key: 'gender', label: 'Gender', env: 'gender', fact: 'gender' },
  { key: 'workAuthorization', label: 'Work authorization', env: 'workAuth', fact: 'workAuthorization' },
  { key: 'currentLocation', label: 'Current location', env: 'location', fact: 'location' },
];

/**
 * Resolve the application facts: Setup value → (current location only) resume location
 * → .env. Returns the facts plus where each value came from, for the Setup page.
 */
function applicationFacts(profile, prefs, cv = {}) {
  const u = (profile && profile.userProvided) || {};
  const facts = {};
  const sources = [];
  for (const f of APP_FACTS) {
    const envRaw = String(cv[f.env] || '').trim();
    const envValue = f.env === 'workAuth' && envRaw === DEFAULT_WORK_AUTH ? '' : envRaw;
    let value = String(u[f.key] || '').trim();
    let source = value ? 'setup' : null;
    if (!value && f.key === 'currentLocation' && profile && profile.location) { value = profile.location; source = 'resume'; }
    if (!value && envValue) { value = envValue; source = 'env'; }
    if (value) facts[f.fact] = value;
    sources.push({ key: f.key, label: f.label, value, source, envValue });
  }
  const reloc = prefs && prefs.relocation === 'yes' ? 'Yes' : prefs && prefs.relocation === 'no' ? 'No' : '';
  if (reloc) facts.willingToRelocate = reloc;
  sources.push({ key: 'relocation', label: 'Willing to relocate', value: reloc, source: reloc ? 'setup' : null, envValue: '' });
  const modes = prefs ? (prefs.workModes || []).join(', ') : '';
  if (modes) facts.preferredWorkModes = modes;
  sources.push({ key: 'workModes', label: 'Remote / hybrid / on-site', value: modes, source: modes ? 'setup' : null, envValue: '' });
  return { facts, sources };
}

/**
 * Facts for the answer engine = resume profile (Setup) + application facts. Nothing else
 * from .env is used (no skills/role/highlights from .env). Empty values never become facts.
 */
function factsFor(profile, prefs = null, cv = {}) {
  const f = {};
  if (profile) {
    const u = profile.userProvided || {};
    const current = (profile.jobs || []).find((j) => /present|current|now|till date/i.test(j.end || '')) || null;
    Object.assign(f, {
      name: profile.name, email: profile.email, phone: profile.phone,
      currentRole: current ? current.title : '', currentCompany: current ? current.employer : '',
      skills: [...(profile.skills || []), ...(profile.tools || [])].join(', '),
      languages: (profile.languages || []).join(', '),
      employmentHistory: (profile.jobs || []).map((j) => `${j.title} at ${j.employer} (${j.start || '?'} – ${j.end || '?'})`),
      education: (profile.education || []).map((e) => [e.degree, e.institution, e.year].filter(Boolean).join(', ')),
      certifications: profile.certifications, projects: (profile.projects || []).map((p) => p.description ? `${p.name}: ${p.description}` : p.name),
      totalExperience: u.totalExperienceYears,
    });
  }
  Object.assign(f, applicationFacts(profile, prefs, cv).facts);
  if (prefs && !prefs.anyLocation && (prefs.cities || []).length) {
    const F = require('./naukri-filters');
    f.preferredLocations = prefs.cities.map((g) => (F.cityByGid(g) || {}).name).filter(Boolean).join(', ');
  }
  return strip(f);
}
function strip(o) {
  for (const k of Object.keys(o)) if (o[k] == null || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
  return o;
}

/**
 * Setup pre-fill from the resume (the user only confirms): current/recent job titles,
 * the first skills as keywords, the city from the current/resume location. Everything
 * comes from the profile itself — nothing is suggested that the resume doesn't say.
 */
function suggestPreferences(profile) {
  if (!profile) return { titles: [], keywords: [], cities: [] };
  const jobs = [...(profile.jobs || [])].sort((a, b) =>
    Number(/present|current|now|till date/i.test(b.end || '')) - Number(/present|current|now|till date/i.test(a.end || '')));
  const seen = new Set();
  const titles = [];
  const add = (t) => { t = String(t || '').trim(); if (t && t.length <= 60 && /[a-z]/i.test(t) && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); titles.push(t); } };
  add(String(profile.headline || '').split(/[|,•·]/)[0]); // "Data Analyst | SQL | Power BI" → "Data Analyst"
  for (const j of jobs) { if (titles.length >= 3) break; add(j.title); }
  const keywords = [...new Set((profile.skills || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 5);
  // only a city Naukri's filter confirms (docs/NAUKRI-FILTERS.md)
  const city = require('./naukri-filters').cityByName((profile.userProvided && profile.userProvided.currentLocation) || profile.location || '');
  return { titles: titles.slice(0, 3), keywords, cities: city ? [city.gid] : [] };
}

module.exports = { PROFILE, APP_FACTS, suggestPreferences, extractPdfText, grounded, groundProfile, buildProfile, load, save, applicationFacts, factsFor };
