/** node --test profile-setup.test.js — resume extraction, grounding, preferences. Gemini mocked. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./resume-profile');
const P = require('./preferences');

/** A minimal one-page PDF with the given lines (Helvetica), no dependency needed. */
function makePdf(lines) {
  const esc = (s) => s.replace(/[()\\]/g, '\\$&');
  const content = `BT /F1 12 Tf 14 TL 50 750 Td ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
const RESUME = [
  'Test Candidate', 'test.candidate@example.com | +91 98765 43210 | Pune',
  'Skills: SQL, Power BI, Excel, Python',
  'Data Analyst, Acme Analytics, Jan 2022 - Present',
  'Junior Analyst, Beta Corp, Jun 2020 - Dec 2021',
  'B.Sc Statistics, Pune University, 2020',
  'Certification: PL-300 Power BI Data Analyst',
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
const gemini = (obj) => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), headers: { get: () => null } });
const { createAi } = require('./ai-providers');
const chain = (fetchImpl) => createAi({ gemini: { apiKey: 'k', model: 'm' } }, { fetchImpl, stateFile: null, sleep: async () => {} });

test('PDF text is extracted locally', async () => {
  const f = path.join(tmp(), 'resume.pdf');
  fs.writeFileSync(f, makePdf(RESUME));
  const text = await R.extractPdfText(f);
  for (const l of ['Test Candidate', 'Skills: SQL, Power BI, Excel, Python', 'Acme Analytics']) assert.ok(text.includes(l), l);
});

test('grounding keeps only what the resume says; guesses are dropped and listed', async () => {
  const text = RESUME.join('\n');
  const { profile, dropped, ai } = await R.buildProfile(text, { ai: chain(gemini({
    name: 'Test Candidate', email: 'test.candidate@example.com', phone: '+919876543210', location: 'Pune, Maharashtra',
    skills: ['SQL', 'Power BI', 'Tableau'], tools: ['Excel'], languages: [],
    jobs: [{ title: 'Data Analyst', employer: 'Acme Analytics', start: 'Jan 2022', end: 'Present' },
      { title: 'Team Lead', employer: 'Gamma Inc', start: '2019', end: '2020' }],
    education: [{ degree: 'B.Sc Statistics', institution: 'Pune University', year: '2020' }],
    certifications: ['PL-300 Power BI Data Analyst', 'AWS Certified'],
    projects: [],
  })) });
  assert.strictEqual(ai, 'ok (gemini m)');
  assert.strictEqual(profile.name, 'Test Candidate');
  assert.strictEqual(profile.phone, '+919876543210', 'phone matched on digits');
  assert.strictEqual(profile.location, '', '"Pune, Maharashtra" is not written in the resume');
  assert.deepStrictEqual(profile.skills, ['SQL', 'Power BI']);
  assert.deepStrictEqual(profile.jobs.map((j) => j.employer), ['Acme Analytics'], 'invented job removed');
  assert.deepStrictEqual(profile.certifications, ['PL-300 Power BI Data Analyst']);
  for (const x of ['skills: Tableau', 'certifications: AWS Certified', 'location: Pune, Maharashtra']) assert.ok(dropped.includes(x), x);
});

test('no key or an AI error → only literal email/phone, nothing guessed', async () => {
  const text = RESUME.join('\n');
  for (const opts of [{ ai: null }, { ai: chain(async () => { throw new Error('offline'); }) }]) {
    const { profile, ai } = await R.buildProfile(text, opts);
    assert.strictEqual(profile.email, 'test.candidate@example.com');
    assert.ok(profile.phone.includes('98765'));
    assert.strictEqual(profile.name, '');
    assert.deepStrictEqual(profile.skills, []);
    assert.ok(/not configured|AI error/.test(ai));
  }
});

const ENV_CV = { // what config.js builds from .env
  name: 'Env Name', email: 'env@example.com', skills: 'Kubernetes, Go', currentRole: 'Env Role', highlights: ['env highlight'],
  noticePeriod: '60 days', currentCTC: '5', expectedCTC: '7', dob: '01/01/1999', gender: 'Female',
  workAuth: 'Authorized to work in my country of residence.', // config default, not user data
  location: 'Env City', relocate: 'Yes, I am open to relocation.', remoteOk: 'Yes, I am fully set up for remote work',
};

test('profile.json round trip; resume facts + Setup application facts', () => {
  const f = path.join(tmp(), 'profile.json');
  R.save({ name: 'Test Candidate', skills: ['SQL'], tools: ['Excel'], location: 'Pune',
    jobs: [{ title: 'Data Analyst', employer: 'Acme', start: '2022', end: 'Present' }],
    userProvided: { noticePeriod: '30 days', currentCTC: '', expectedCTC: '8', dateOfBirth: '02/02/2000', gender: 'Male',
      workAuthorization: 'Indian citizen', currentLocation: 'Mumbai' } }, f);
  const facts = R.factsFor(R.load(f), P.normalize({ relocation: 'yes', workModes: ['remote', 'hybrid'] }), ENV_CV);
  assert.strictEqual(facts.currentRole, 'Data Analyst');
  assert.strictEqual(facts.skills, 'SQL, Excel', 'skills from the resume profile only — never .env');
  assert.strictEqual(facts.name, 'Test Candidate');
  assert.strictEqual(facts.noticePeriod, '30 days', 'Setup wins over .env');
  assert.strictEqual(facts.dateOfBirth, '02/02/2000');
  assert.strictEqual(facts.gender, 'Male');
  assert.strictEqual(facts.workAuthorization, 'Indian citizen');
  assert.strictEqual(facts.location, 'Mumbai', 'current location from Setup beats the resume');
  assert.strictEqual(facts.currentCTC_lakhs, '5', 'empty in Setup → .env fallback');
  assert.strictEqual(facts.willingToRelocate, 'Yes');
  assert.strictEqual(facts.preferredWorkModes, 'remote, hybrid');
});

test('.env is a fallback ONLY for the application facts, and sources are reported', () => {
  const { facts, sources } = R.applicationFacts({ location: 'Pune', userProvided: { gender: 'Male' } }, P.normalize({}), ENV_CV);
  const src = Object.fromEntries(sources.map((s) => [s.key, s.source]));
  assert.deepStrictEqual(src, { noticePeriod: 'env', currentCTC: 'env', expectedCTC: 'env', dateOfBirth: 'env', gender: 'setup',
    workAuthorization: null, currentLocation: 'resume', relocation: null, workModes: null });
  assert.ok(!('workAuthorization' in facts), 'the config.js default work-auth sentence is not a fact');
  assert.ok(!('willingToRelocate' in facts) && !('preferredWorkModes' in facts), 'no fallback to invented .env sentences');
  const noProfile = R.factsFor(null, null, ENV_CV);
  assert.ok(!('skills' in noProfile) && !('name' in noProfile) && !('email' in noProfile) && !('currentRole' in noProfile),
    'without a profile, .env gives only the application facts');
  assert.strictEqual(noProfile.noticePeriod, '60 days');
  assert.strictEqual(noProfile.location, 'Env City');
});

test('Setup collects every required application fact', () => {
  const keys = R.APP_FACTS.map((f) => f.key);
  for (const k of ['noticePeriod', 'currentCTC', 'expectedCTC', 'dateOfBirth', 'gender', 'workAuthorization', 'currentLocation']) assert.ok(keys.includes(k), k);
  const setup = fs.readFileSync(path.join(__dirname, 'app', 'renderer', 'setup.js'), 'utf8');
  assert.ok(setup.includes('setupData.appFacts.map(factRow)'), 'form fields are generated from APP_FACTS');
  assert.ok(setup.includes("chk('s-remote'") && setup.includes("h('select', { id: 's-reloc' }"), 'relocation + work modes in preferences');
});

test('preferences: limits can be lowered, never raised; searches use only slug + experience', () => {
  const p = P.normalize({ titles: ['Data Analyst', 'Power BI Developer', 'data analyst'], experience: { min: '3' }, limits: { perRun: 25, daily: 100 } });
  assert.deepStrictEqual(p.limits, { perRun: 10, daily: 50 });
  assert.deepStrictEqual(P.normalize({ limits: { perRun: 4, daily: 20 } }).limits, { perRun: 4, daily: 20 });
  assert.deepStrictEqual(P.buildSearches(p), [
    'https://www.naukri.com/data-analyst-jobs?experience=3',
    'https://www.naukri.com/power-bi-developer-jobs?experience=3',
  ]);
  assert.deepStrictEqual(P.buildSearches(P.normalize({ titles: ['SQL / BI analyst'] })), ['https://www.naukri.com/sql-bi-analyst-jobs']);
  assert.deepStrictEqual(P.buildSearches(P.normalize({})), [], 'no titles → built-in searches stay');
  const tf = P.titleFilter(P.normalize({ titles: ['Data Analyst'], includeKeywords: ['MIS'], excludeKeywords: ['Sales'] }));
  assert.deepStrictEqual(tf, { keywords: ['data analyst', 'mis'], blocklist: ['sales'] });
});
