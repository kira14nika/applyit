/** node --test naukri-filters.test.js — only confirmed Naukri filters reach a URL (docs/NAUKRI-FILTERS.md). */
const test = require('node:test');
const assert = require('assert');
const F = require('./naukri-filters');
const P = require('./preferences');
const R = require('./resume-profile');

test('the URL verified live is reproduced exactly', () => {
  // verified 2026-09-28: 106 results, all filters shown as applied
  assert.strictEqual(F.searchUrl('Data Analyst', { experience: 3, workModes: ['remote', 'hybrid'], cities: [139, 97], salary: ['6to10'], jobAge: 7 }),
    'https://www.naukri.com/data-analyst-jobs?experience=3&wfhType=2&wfhType=3&cityTypeGid=139&cityTypeGid=97&ctcFilter=6to10&jobAge=7');
  assert.strictEqual(F.searchUrl('Business analyst', { experience: 3, cities: [139], jobAge: 15 }),
    'https://www.naukri.com/business-analyst-jobs?experience=3&cityTypeGid=139&jobAge=15');
  assert.strictEqual(F.searchUrl('Power BI Developer', {}), 'https://www.naukri.com/power-bi-developer-jobs');
});

test('unconfirmed values never reach a URL', () => {
  const u = F.searchUrl('Data Analyst', { experience: 45, workModes: ['remote', 'teleport'], cities: [139, 999999], salary: ['6to10', 'lots'], jobAge: 5 });
  assert.strictEqual(u, 'https://www.naukri.com/data-analyst-jobs?experience=30&wfhType=2&cityTypeGid=139&ctcFilter=6to10');
  assert.deepStrictEqual(Object.keys(F.WORK_MODES).map((k) => F.WORK_MODES[k]), [0, 2, 3]);
  assert.deepStrictEqual(F.FRESHNESS, [1, 3, 7, 15, 30]);
  assert.strictEqual(F.CITIES.length, 28);
  assert.strictEqual(F.SALARY.length, 9);
  assert.strictEqual(F.searchUrl('  ', {}), null);
});

test('preferences: one search per title with every selected filter; any location = no city param', () => {
  const p = P.normalize({ titles: ['Data Analyst', 'BI Analyst'], cities: [139], workModes: ['remote'], experience: { min: 2, max: 5 }, jobAge: 7, salaryRanges: ['6to10', 'bogus'] });
  assert.deepStrictEqual(P.buildSearches(p), [
    'https://www.naukri.com/data-analyst-jobs?experience=2&wfhType=2&cityTypeGid=139&ctcFilter=6to10&jobAge=7',
    'https://www.naukri.com/bi-analyst-jobs?experience=2&wfhType=2&cityTypeGid=139&ctcFilter=6to10&jobAge=7',
  ]);
  assert.deepStrictEqual(p.salaryRanges, ['6to10']);
  const any = P.normalize({ titles: ['Data Analyst'], cities: [], anyLocation: true });
  assert.strictEqual(any.anyLocation, true);
  assert.strictEqual(P.buildSearches(any)[0], 'https://www.naukri.com/data-analyst-jobs');
  assert.deepStrictEqual(P.normalize({ experience: { min: 5, max: 2 } }).experience, { min: 5, max: 5 }, 'max never below min');
});

test('old free-text locations migrate to confirmed cities ("Pune, anywhere in india" → Pune)', () => {
  const p = P.normalize({ locations: ['Pune, anywhere in india'] });
  assert.deepStrictEqual([p.cities, p.anyLocation, p.unmatchedLocations], [[139], false, undefined]);
  const q = P.normalize({ locations: ['Atlantis', 'bangalore'] });
  assert.deepStrictEqual([q.cities, q.unmatchedLocations], [[97], ['Atlantis']]);
  assert.strictEqual(P.normalize({ locations: ['anywhere'] }).anyLocation, true);
});

test('local location words: aliases for Delhi / NCR; "India" means anywhere', () => {
  const lf = P.locationFilter(P.normalize({ cities: [9508], workModes: ['remote'] }));
  assert.ok(lf.locations.includes('Delhi') && lf.locations.includes('Noida') && lf.locations.includes('Gurugram'));
  assert.strictEqual(lf.remote, true);
  assert.strictEqual(P.locationFilter(P.normalize({ cities: [9011] })), null);
  assert.strictEqual(P.locationFilter(P.normalize({})), null);
});

test('Setup pre-fill: headline + recent titles, city only if it is a confirmed Naukri city', () => {
  const s = R.suggestPreferences({ headline: 'Data Analyst | SQL | Power BI', location: 'Pune, Maharashtra',
    jobs: [{ title: 'Junior Analyst', end: '2021' }, { title: 'Data Analyst', end: 'Present' }, { title: 'BI Intern', end: '2019' }], skills: ['SQL'] });
  assert.deepStrictEqual(s.titles, ['Data Analyst', 'Junior Analyst', 'BI Intern']);
  assert.deepStrictEqual(s.cities, [139]);
  assert.deepStrictEqual(R.suggestPreferences({ location: 'Atlantis' }).cities, []);
});

test('the Setup page only offers filter values from naukri-filters.js', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'app', 'renderer', 'setup.js'), 'utf8');
  for (const x of ['F.cities.map', 'F.freshness.map', 'F.salary.map', 'F.experience.max']) assert.ok(src.includes(x), x);
  assert.ok(!/s-locs|s-salmin|s-salmax/.test(src), 'no free-text city or salary boxes');
  const main = require('fs').readFileSync(require('path').join(__dirname, 'app', 'main.js'), 'utf8');
  assert.ok(main.includes("return { cities: F.CITIES, salary: F.SALARY, freshness: F.FRESHNESS, experience: F.EXPERIENCE }"));
});
