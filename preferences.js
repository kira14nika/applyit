/**
 * preferences.json (git-ignored): what the user wants, entered once in Setup.
 *
 * Searches are built ONLY from the two URL parts the engine already uses —
 * https://www.naukri.com/<keyword-slug>-jobs?experience=<years> — no invented params.
 * Everything else (locations, work modes, salary, include/exclude words) is used for
 * filtering and advisory matching, never put in a URL.
 * Limits can be lowered, never raised above 10 per run / 50 per day.
 */
const fs = require('fs');
const path = require('path');

const PREFERENCES = path.join(__dirname, 'preferences.json');
const MAX = { perRun: 10, daily: 50 };

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const clampInt = (v, max) => { const n = Math.floor(num(v) ?? max); return Math.min(max, Math.max(1, n)); };

function normalize(p = {}) {
  const exp = { min: num(p.experience?.min), max: num(p.experience?.max) };
  const sal = { min: num(p.salary?.min), max: num(p.salary?.max) };
  return {
    titles: list(p.titles),
    locations: list(p.locations),
    anyLocation: !!p.anyLocation || !list(p.locations).length,
    workModes: list(p.workModes).filter((m) => ['remote', 'hybrid', 'on-site'].includes(m)),
    relocation: ['yes', 'no'].includes(p.relocation) ? p.relocation : 'unspecified',
    salary: sal,                 // lakhs per annum, advisory
    experience: exp,             // years
    includeKeywords: list(p.includeKeywords),
    excludeKeywords: list(p.excludeKeywords),
    limits: { perRun: clampInt(p.limits?.perRun, MAX.perRun), daily: clampInt(p.limits?.daily, MAX.daily) },
    // AI match threshold — OFF by default, and advisory even when on (flags, never skips)
    matching: {
      aiEnabled: p.matching?.aiEnabled === true, // "AI matching (uses AI quota)" — default OFF: rules only
      thresholdEnabled: p.matching?.thresholdEnabled === true,
      threshold: Math.min(100, Math.max(0, Math.round(num(p.matching?.threshold) ?? 60))),
    },
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Search URLs in the exact shape the engine already uses. Empty when no titles are set. */
function buildSearches(prefs) {
  const exp = prefs.experience && prefs.experience.min != null ? Math.max(0, Math.floor(prefs.experience.min)) : null;
  return [...new Set(prefs.titles.map(slug).filter(Boolean))]
    .map((s) => `https://www.naukri.com/${s}-jobs${exp != null ? `?experience=${exp}` : ''}`);
}

/** What the page's title filter uses: titles + include words; exclude words block. */
function titleFilter(prefs) {
  return {
    keywords: [...new Set([...prefs.titles, ...prefs.includeKeywords].map((s) => s.toLowerCase()))],
    blocklist: [...new Set(prefs.excludeKeywords.map((s) => s.toLowerCase()))],
  };
}

function load(file = PREFERENCES) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { return null; }
}
function save(p, file = PREFERENCES) {
  const clean = { ...normalize(p), savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { PREFERENCES, MAX, normalize, buildSearches, titleFilter, slug, load, save };
