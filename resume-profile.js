/**
 * Resume → profile.json. Everything here runs in Node.
 *
 *   extractPdfText(file)                       local text extraction (pdfjs-dist)
 *   buildProfile(text, {apiKey, model})        Gemini structures the text, then EVERY value
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
const { askJson } = require('./answer-engine');

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
async function buildProfile(text, { apiKey = '', model, fetchImpl } = {}) {
  const base = { ...EMPTY(), email: (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0],
    phone: (text.match(/\+?\d[\d\s-]{8,}\d/) || [''])[0].trim() };
  if (!apiKey) return { profile: base, dropped: [], ai: 'not configured (GEMINI_KEY is empty) — fill the profile in by hand' };
  const res = await askJson(`${PROMPT}\n\nRESUME TEXT:\n${text.slice(0, 30000)}`, { apiKey, model, fetchImpl });
  if (!res.ok) return { profile: base, dropped: [], ai: `AI error: ${res.error}` };
  const { profile, dropped } = groundProfile(res.json || {}, text);
  if (!profile.email) profile.email = base.email;
  if (!profile.phone) profile.phone = base.phone;
  return { profile, dropped, ai: 'ok' };
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
 * Facts for the answer engine. profile.json (resume-derived + user-provided) wins;
 * the .env CV fills only what the profile lacks; preferences add explicit choices
 * (relocation, work modes, locations). Empty values never become facts.
 */
function factsFromProfile(profile, cvFacts = {}, prefs = null) {
  const f = { ...cvFacts };
  if (profile) {
    const u = profile.userProvided || {};
    const current = (profile.jobs || []).find((j) => /present|current|now|till date/i.test(j.end || '')) || null;
    Object.assign(f, strip({
      name: profile.name, email: profile.email, phone: profile.phone, location: profile.location,
      currentRole: current ? current.title : '', currentCompany: current ? current.employer : '',
      skills: [...(profile.skills || []), ...(profile.tools || [])].join(', '),
      languages: (profile.languages || []).join(', '),
      employmentHistory: (profile.jobs || []).map((j) => `${j.title} at ${j.employer} (${j.start || '?'} – ${j.end || '?'})`),
      education: (profile.education || []).map((e) => [e.degree, e.institution, e.year].filter(Boolean).join(', ')),
      certifications: profile.certifications, projects: (profile.projects || []).map((p) => p.description ? `${p.name}: ${p.description}` : p.name),
      noticePeriod: u.noticePeriod, currentCTC_lakhs: u.currentCTC, expectedCTC_lakhs: u.expectedCTC,
      totalExperience: u.totalExperienceYears, workAuthorization: u.workAuthorization,
    }));
  }
  if (prefs) {
    Object.assign(f, strip({
      willingToRelocate: prefs.relocation === 'yes' ? 'Yes' : prefs.relocation === 'no' ? 'No' : '',
      preferredWorkModes: (prefs.workModes || []).join(', '), preferredLocations: (prefs.locations || []).join(', '),
    }));
  }
  return strip(f);
}
function strip(o) {
  for (const k of Object.keys(o)) if (o[k] == null || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
  return o;
}

module.exports = { PROFILE, extractPdfText, grounded, groundProfile, buildProfile, load, save, factsFromProfile };
