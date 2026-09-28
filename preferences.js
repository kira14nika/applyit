/**
 * preferences.json (git-ignored): what the user wants, entered once in Setup.
 *
 * Naukri searches use ONLY the filters confirmed live (docs/NAUKRI-FILTERS.md, held in
 * naukri-filters.js): keyword slug + experience, jobAge, wfhType, cityTypeGid, ctcFilter.
 * Anything else (include/exclude words, relocation) is used for local filtering and
 * matching, never put in a URL. Limits can be lowered, never raised above 10/run, 50/day.
 */
const fs = require('fs');
const path = require('path');
const F = require('./naukri-filters');

const PREFERENCES = path.join(__dirname, 'preferences.json');
const MAX = { perRun: 10, daily: 50 };

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map((s) => String(s).trim()).filter(Boolean);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const clampInt = (v, max) => { const n = Math.floor(num(v) ?? max); return Math.min(max, Math.max(1, n)); };
const clampExp = (v) => { const n = num(v); return n == null ? null : Math.min(F.EXPERIENCE.max, Math.max(F.EXPERIENCE.min, Math.floor(n))); };

/**
 * Cities: confirmed Naukri gids. Older free-text `locations` ("Pune, anywhere in india")
 * are migrated by name; words that aren't a confirmed city are reported in `unmatchedLocations`.
 */
function citiesOf(p) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c.gid)) out.push(c.gid); };
  for (const g of Array.isArray(p.cities) ? p.cities : []) add(F.cityByGid(typeof g === 'object' ? g.gid : g));
  const unmatched = [];
  for (const raw of Array.isArray(p.locations) ? p.locations : []) {
    for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (/any\s*where|any location|all india|pan india/i.test(part)) continue;
      const c = F.cityByName(part);
      if (c) add(c); else unmatched.push(part);
    }
  }
  return { gids: out, unmatched };
}

function normalize(p = {}) {
  const { gids, unmatched } = citiesOf(p);
  const exp = { min: clampExp(p.experience?.min), max: clampExp(p.experience?.max) };
  if (exp.min != null && exp.max != null && exp.max < exp.min) exp.max = exp.min;
  return {
    titles: list(p.titles),
    cities: gids,
    anyLocation: !gids.length, // no city chosen = any location
    ...(unmatched.length ? { unmatchedLocations: unmatched } : {}),
    workModes: list(p.workModes).filter((m) => m in F.WORK_MODES),
    relocation: ['yes', 'no'].includes(p.relocation) ? p.relocation : 'unspecified',
    experience: exp,                                   // years; Naukri's URL takes one value → min
    jobAge: F.FRESHNESS.includes(Number(p.jobAge)) ? Number(p.jobAge) : null,
    salaryRanges: list(p.salaryRanges).filter((v) => F.SALARY.some((s) => s.value === v)),
    includeKeywords: list(p.includeKeywords),
    excludeKeywords: list(p.excludeKeywords),
    limits: { perRun: clampInt(p.limits?.perRun, MAX.perRun), daily: clampInt(p.limits?.daily, MAX.daily) },
    matching: {
      aiEnabled: p.matching?.aiEnabled === true,           // "AI matching (uses AI quota)" — default OFF: rules only
      thresholdEnabled: p.matching?.thresholdEnabled !== false, // low-match gate — default ON …
      threshold: Math.min(100, Math.max(0, Math.round(num(p.matching?.threshold) ?? 50))), // … at 50%
    },
  };
}

/** One search per job title, with every selected confirmed filter in the URL. */
function buildSearches(prefs) {
  const f = {
    experience: prefs.experience ? prefs.experience.min : null,
    jobAge: prefs.jobAge,
    workModes: prefs.workModes,
    cities: prefs.anyLocation ? [] : prefs.cities,
    salary: prefs.salaryRanges,
  };
  return [...new Set(prefs.titles.map((t) => F.searchUrl(t, f)).filter(Boolean))];
}

/** What the page's title filter uses: titles + include words; exclude words block. */
function titleFilter(prefs) {
  return {
    keywords: [...new Set([...prefs.titles, ...prefs.includeKeywords].map((s) => s.toLowerCase()))],
    blocklist: [...new Set(prefs.excludeKeywords.map((s) => s.toLowerCase()))],
  };
}

/** Local location check words for the chosen cities (null = anywhere). */
function locationFilter(prefs) {
  if (prefs.anyLocation || !prefs.cities.length) return null;
  const words = prefs.cities.flatMap((g) => F.cityWords(F.cityByGid(g)));
  if (prefs.cities.includes(9011)) return null; // "India" chosen = anywhere
  return { locations: [...new Set(words)], remote: prefs.workModes.includes('remote') };
}

function load(file = PREFERENCES) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { return null; }
}
function save(p, file = PREFERENCES) {
  const clean = { ...normalize(p), savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { PREFERENCES, MAX, normalize, buildSearches, titleFilter, locationFilter, slug: F.slug, load, save };
