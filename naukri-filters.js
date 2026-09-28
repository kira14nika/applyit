/**
 * Naukri search filters — ONLY the values confirmed live in docs/NAUKRI-FILTERS.md.
 * Nothing else may be put in a Naukri URL. Re-measure and update both files if Naukri
 * changes them.
 */
const WORK_MODES = { 'on-site': 0, remote: 2, hybrid: 3 };      // wfhType (multi)
const FRESHNESS = [1, 3, 7, 15, 30];                             // jobAge (single, days)
const EXPERIENCE = { min: 0, max: 30 };                          // experience (single, years)
const SALARY = [                                                 // ctcFilter (multi)
  { value: '0to3', label: '0-3 Lakhs' }, { value: '3to6', label: '3-6 Lakhs' }, { value: '6to10', label: '6-10 Lakhs' },
  { value: '10to15', label: '10-15 Lakhs' }, { value: '15to25', label: '15-25 Lakhs' }, { value: '25to50', label: '25-50 Lakhs' },
  { value: '50to75', label: '50-75 Lakhs' }, { value: '75to100', label: '75-100 Lakhs' }, { value: '100to500', label: '1-5 Cr' },
];
const CITIES = [                                                 // cityTypeGid (multi)
  ['Ahmedabad', 51], ['Bengaluru', 97], ['Chandigarh', 4], ['Chennai', 183], ['Coimbatore', 184], ['Delhi / NCR', 9508],
  ['Gurugram', 73], ['Hyderabad', 17], ['India', 9011], ['Indore', 125], ['Jaipur', 173], ['Khopoli', 349], ['Kochi', 110],
  ['Kolkata', 232], ['Lonavala', 507], ['Lucknow', 216], ['Mohali', 167], ['Mumbai', 134], ['Mumbai (All Areas)', 9509],
  ['Nagpur', 136], ['Navi Mumbai', 138], ['New Delhi', 6], ['Noida', 220], ['Pune', 139], ['Surat', 64], ['Thane', 323],
  ['Thiruvananthapuram', 120], ['Vadodara', 65],
].map(([name, gid]) => ({ name, gid }));

const cityByGid = (gid) => CITIES.find((c) => c.gid === Number(gid)) || null;
/** Resume/free-text city → a confirmed Naukri city (exact name, or the part before "," / "("), or null. */
function cityByName(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const head = t.split(/[,(]/)[0].trim();
  return CITIES.find((c) => c.name.toLowerCase() === t) || CITIES.find((c) => c.name.toLowerCase() === head)
    || (/^bangalore$/.test(head) ? cityByGid(97) : /^(gurgaon)$/.test(head) ? cityByGid(73) : /^(bombay)$/.test(head) ? cityByGid(134) : null);
}
/** Words a job card's location may show for a chosen city (for the local location check). */
function cityWords(city) {
  if (!city) return [];
  if (city.gid === 9011) return []; // "India" = anywhere: no local restriction
  const base = city.name.replace(/\s*\(.*\)\s*/, '').split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const extra = { 9508: ['Delhi', 'NCR', 'Gurugram', 'Gurgaon', 'Noida', 'Ghaziabad', 'Faridabad'], 97: ['Bangalore'], 73: ['Gurgaon'], 9509: ['Mumbai', 'Thane', 'Navi Mumbai'] }[city.gid] || [];
  return [...new Set([...base, ...extra])];
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * One search URL for a job title with every selected confirmed filter.
 * f = {experience, jobAge, workModes: ['remote','hybrid','on-site'], cities: [gid], salary: ['6to10', …]}
 * Unknown / unconfirmed values are dropped, never sent.
 */
function searchUrl(title, f = {}) {
  const s = slug(title);
  if (!s) return null;
  const q = new URLSearchParams();
  const exp = Number(f.experience);
  if (f.experience !== '' && f.experience != null && Number.isFinite(exp)) q.append('experience', String(Math.min(EXPERIENCE.max, Math.max(EXPERIENCE.min, Math.floor(exp)))));
  for (const m of f.workModes || []) if (m in WORK_MODES) q.append('wfhType', String(WORK_MODES[m]));
  for (const g of f.cities || []) if (cityByGid(g)) q.append('cityTypeGid', String(Number(g)));
  for (const v of f.salary || []) if (SALARY.some((x) => x.value === v)) q.append('ctcFilter', v);
  if (FRESHNESS.includes(Number(f.jobAge))) q.append('jobAge', String(Number(f.jobAge)));
  const qs = q.toString();
  return `https://www.naukri.com/${s}-jobs${qs ? `?${qs}` : ''}`;
}

module.exports = { WORK_MODES, FRESHNESS, EXPERIENCE, SALARY, CITIES, cityByGid, cityByName, cityWords, searchUrl, slug };
