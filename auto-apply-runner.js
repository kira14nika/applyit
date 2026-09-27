/**
 * Auto-Apply Runner — drives the existing console auto-apply scripts with Playwright,
 * so no more F12 + paste: it injects indeed-auto-apply.js / wellfound-auto-apply.js
 * into the page automatically on every load (that IS the "paste again" step).
 *
 * Usage:
 *   node auto-apply-runner.js indeed login      one-time: visible Chrome opens — log in manually, then close the window
 *   node auto-apply-runner.js indeed            dry run: fills everything, never submits
 *   node auto-apply-runner.js indeed --live     applies for real
 *   node auto-apply-runner.js wellfound [login|--live]
 *
 * Each run picks a random target of 10–25 applications (2 sites ≈ 20–50/day),
 * runs off-screen, and stops after the target or 100 minutes.
 */
const path = require('path');
const fs = require('fs');
const { CV, geminiKey, resumePath: RESUME_PATH } = require('./config'); // personal data from .env
const { minimizeBrowserWindows, hideBrowserWindows, SHOW_FLAG } = require('./window-utils');
const { applyExternal } = require('./external-apply'); // "Apply on company site" jobs, driven from Node
// stealth patches the fingerprint leaks reCAPTCHA uses to flag automation; falls back to plain playwright
let chromium;
try {
  const { addExtra } = require('playwright-extra');
  chromium = addExtra(require('playwright-core').chromium);
  chromium.use(require('puppeteer-extra-plugin-stealth')());
} catch (e) {
  ({ chromium } = require('playwright-core'));
}

const { parseMode, mayClick, isBenignRace } = require('./safety');

// Page reloads (naukri clicking "Next") race the stealth plugin's CDP session and throw
// async rejections outside any await. ONLY those known races are ignored; anything
// else is a real bug and is reported as an error (rejection) or ends the run (exception).
const stamp = () => `[${new Date().toLocaleString()}]`;
const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
let surfacedErrors = 0;
process.on('unhandledRejection', (e) => {
  if (isBenignRace(e)) return console.log(`${stamp()} (ignored navigation race) ${firstLine(e).slice(0, 120)}`);
  surfacedErrors++;
  console.error(`${stamp()} ERROR unhandledRejection: ${(e && e.stack) || e}`);
});
process.on('uncaughtException', (e) => {
  if (isBenignRace(e)) return console.log(`${stamp()} (ignored navigation race) ${firstLine(e).slice(0, 120)}`);
  console.error(`${stamp()} FATAL uncaughtException: ${(e && e.stack) || e}`);
  process.exit(1); // state is unknown after an uncaught exception; Playwright closes Chrome on exit
});

const SITE_ARG = process.argv[2];
const LOGIN_MODE = process.argv.includes('login');
// DRY (default) | TEST (--test --only=…) | LIVE (--live + confirmation). See safety.js.
let POLICY;
try { POLICY = parseMode(process.argv); } catch (e) { console.log(`Usage error: ${e.message}`); process.exit(1); }
const MODE = POLICY.mode;
// "real" mode: clicks may happen (each one still asks the Node click gate) and the
// ledger/CSV are written. TEST is real, but only for its allow-listed job ids.
const LIVE = MODE !== 'DRY';
// --scheduled marks a run started by Task Scheduler rather than by hand. Such runs
// wait a random 0-14 minutes before starting and refuse to run outside daytime hours,
// because a burst of applications at exactly HH:00:00, around the clock, is the most
// obviously non-human thing an hourly job can do.
const SCHEDULED = process.argv.includes('--scheduled');
const ACTIVE_FROM = 9;   // 09:00
const ACTIVE_UNTIL = 23; // 23:00 (exclusive)
// Window handling: hidden by default (off screen and out of the taskbar, so a run is
// invisible), --minimize to keep it in the taskbar, --show to leave it on screen.
// `node show-windows.js` brings a hidden window back.
const SHOW_WINDOW = process.argv.includes('--show');
const MINIMIZE_ONLY = process.argv.includes('--minimize');

const SITES = {
  indeed: {
    script: 'indeed-auto-apply.js',
    profile: '.indeed-chrome-profile',
    // sort=date → newest first; fromage=14 → only jobs posted in the last 14 days; no location filter
    searches: [
      'https://in.indeed.com/jobs?q=full+stack+developer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=software+developer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=backend+developer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=ai+engineer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=gen+ai+developer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=react+developer&sort=date&fromage=14',
      'https://in.indeed.com/jobs?q=node+js+developer&sort=date&fromage=14',
    ],
    loginUrl: 'https://in.indeed.com/account/login',
    injectOn: (url) => /indeed\./.test(url),
    // count both real submits and dry-run "would submit" so pacing works in both modes
    submittedRe: /application submitted|would click: "Submit/i,
    storeKey: 'autoApply', // localStorage key the console script uses (seen jobs + submit count)
  },
  wellfound: {
    script: 'wellfound-auto-apply.js',
    profile: '.wellfound-chrome-profile',
    // /jobs alone dead-ends at 19 listings; the role pages carry the real inventory
    // (measured 2026-08-12). Same list the console script walks internally.
    searches: [
      'https://wellfound.com/jobs',
      'https://wellfound.com/role/l/software-engineer/india',
      'https://wellfound.com/role/r/software-engineer',
      'https://wellfound.com/role/r/backend-engineer',
      'https://wellfound.com/role/r/full-stack-engineer',
      'https://wellfound.com/role/r/frontend-engineer',
      'https://wellfound.com/role/r/mobile-engineer',
    ],
    loginUrl: 'https://wellfound.com/login',
    // Wellfound's own record of what was submitted. Checked after every live apply:
    // the in-page "Applied" stamp only reflects the DOM the apply flow just touched,
    // so it cannot tell a real submission from one that looked fine and never
    // registered. /jobs/applied redirects here.
    appliedListUrl: 'https://wellfound.com/jobs/applications',
    injectOn: (url) => /wellfound\.com/.test(url),
    submittedRe: /application sent|DRY_RUN — would click/i,
    // The wellfound script manages its own per-day seen-list under its own key
    // (wfAutoApplySeen), so the runner has no key to reset here.
    storeKey: null,
    dailyCap: 50,
    perRun: 10, // 10 per hourly run; the 50/day cap still decides when the day ends
  },
  naukri: {
    script: 'naukri-auto-apply.js',
    // ponytail: own profile (copy of the refresh's login) so the long apply run never
    // collides with the hourly refresh on .naukri-chrome-profile. Re-copy if it logs out.
    profile: '.naukri-apply-profile',
    searches: [
      'https://www.naukri.com/data-analyst-jobs?experience=3',
      'https://www.naukri.com/power-bi-developer-jobs?experience=3',
      'https://www.naukri.com/business-analyst-jobs?experience=3',
      'https://www.naukri.com/bi-analyst-jobs?experience=3',
      'https://www.naukri.com/sql-data-analyst-jobs?experience=3',
      'https://www.naukri.com/data-visualization-jobs?experience=3',
    ],
    loginUrl: 'https://www.naukri.com/nlogin/login',
    // inject only on search pages (…-jobs…), never into the job popup the script drives itself
    injectOn: (url) => /naukri\.com\/[^?]*-jobs/.test(url),
    submittedRe: /✅ applied|DRY_RUN — would click/,
    storeKey: 'autoApplyNaukri',
    dailyCap: 50,
    perRun: 10, // 10 per hourly run; the 50/day cap still decides when the day ends
    // naukri-ledger.jsonl is the authority: daily count, per-run count and exclusions
    // come from it, and only a reload-verified APPLIED line counts.
    ledger: true,
    // Keep the search/page position across browser restarts, treat "Next" as progress,
    // and move to the next search on "No more pages" (see session()).
    resumePaging: true,
    // ~85-90% of Naukri dev listings are "Apply on company site" — follow them
    // onto the employer's own form instead of skipping them.
    externalApply: true,
  },
};

const site = SITES[SITE_ARG];
if (!site) {
  console.log('Usage: node auto-apply-runner.js <indeed|wellfound|naukri> [login | --test --only=<id|url,…> | --live --confirm-live] [--show|--minimize] [--scheduled]');
  process.exit(1);
}
// Only ledger sites have the click gate in their page script; anywhere else TEST would
// turn DRY_RUN off with nothing to stop a click.
if (MODE === 'TEST' && !site.ledger) { console.log(`Usage error: --test is only supported for naukri`); process.exit(1); }

// Hard daily cap per site, tracked across runs in a state file — multiple logons in
// one day resume the count instead of restarting it, and stop dead at the cap.
const DAILY_CAP = site.dailyCap || 50;
const STATE_FILE = path.join(__dirname, `apply-state-${SITE_ARG}.json`);
const todayKey = new Date().toDateString();
let dayState = { date: todayKey, count: 0 };
// Ledger sites never read or write the state file; the ledger's APPLIED lines are the count.
const run = site.ledger ? require('./naukri-ledger').startRun({ dailyCap: DAILY_CAP, perRun: site.perRun }) : null;
if (run) dayState.count = run.today;
else try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')); if (s.date === todayKey) dayState = s; } catch (e) {}
const bumpDayCount = () => { dayState.count++; try { fs.writeFileSync(STATE_FILE, JSON.stringify(dayState)); } catch (e) {} };
// per-run target (site.perRun) capped by whatever is left of the daily allowance;
// a TEST run can never want more than its allow-list
const TARGET = run ? (MODE === 'TEST' ? Math.min(run.target, POLICY.allow.size) : run.target)
  : Math.min(site.perRun || DAILY_CAP, DAILY_CAP - dayState.count);
// Company-site jobs parked outside the ledger (naukri-deferred.js), excluded from later runs.
const deferred = run ? require('./naukri-deferred') : null;
const deferredIds = deferred ? deferred.ids() : new Set();
// TEST ends once every allow-listed job reached a final outcome (or was deferred).
const testSeen = new Set();
let testDone = false;
const markTested = (id) => {
  if (MODE !== 'TEST' || !POLICY.allow.has(id)) return;
  testSeen.add(id);
  if (testSeen.size >= POLICY.allow.size) testDone = true;
};
// ponytail: company-site applies are paused on ledger sites — they are not recorded in
// the ledger yet, so they could be repeated every run and would escape both caps.
// Re-enable when external results are written to the ledger (Phase 2C).
const EXTERNAL_ON = site.externalApply && !run;
const MAX_RUNTIME_MS = 100 * 60 * 1000;
const MAX_RESTARTS = 8; // browser gets closed and reopened this many times before giving up
const IDLE_ROTATE_MS = 4 * 60 * 1000;

const log = (msg) => console.log(`[${new Date().toLocaleString()}] [${SITE_ARG}] ${msg}`);

// ======== CSV log of every submitted application (created once, appended forever) ========
const CSV_FILE = path.join(__dirname, 'applications.csv');
const SKILLS = ['JavaScript', 'TypeScript', 'Python', 'Java', 'React', 'Next.js', 'React Native', 'Node.js',
  'Express', 'FastAPI', 'MongoDB', 'PostgreSQL', 'Redis', 'GraphQL', 'WebSockets', 'Docker', 'Kubernetes',
  'GCP', 'AWS', 'CI/CD', 'LangChain', 'LangGraph', 'RAG', 'LLM', 'GenAI', 'Machine Learning', 'MCP', 'Pinecone', 'FAISS'];
const matchSkills = (t) => { const l = t.toLowerCase(); return SKILLS.filter((s) => l.includes(s.toLowerCase())).join('; '); };
const csvRow = (vals) => vals.map((v) => '"' + String(v || '').replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"').join(',') + '\n';
function logApplication(job) {
  // one-time migration: archive a CSV written before the Job Link column existed
  // Also re-archive when the Verified column was added, so older rows (which carry
  // no verification status) are not silently read as unverified.
  if (fs.existsSync(CSV_FILE)) {
    const header = fs.readFileSync(CSV_FILE, 'utf8').split('\n')[0];
    if (!header.includes('Job Link') || !header.includes('Verified')) {
      fs.renameSync(CSV_FILE, path.join(__dirname, 'applications-old.csv'));
    }
  }
  if (!fs.existsSync(CSV_FILE)) {
    // ﻿ BOM so Excel renders ₹/– correctly
    fs.writeFileSync(CSV_FILE, '﻿' + csvRow(['Date', 'Site', 'Role', 'Company', 'CTC/Salary', 'Skills', 'Job Link', 'Verified', 'Job Description']));
  }
  fs.appendFileSync(CSV_FILE, csvRow([new Date().toLocaleString(), SITE_ARG, job.title, job.company, job.salary, job.skills, job.link, job.verified || 'n/a', job.jd]));
}

// Patch the console script: our DRY_RUN flag, our per-run target, and a busy-guard
// so a second injection while one is still running becomes a no-op.
// The job set lives HERE, in Node, not in the page: wellfound's role/job pages do not
// share localStorage with the /jobs feed across navigations (measured 2026-08-12 — the
// stored list kept resetting to 1), so the script re-opened the same job every cycle.
const seenJobs = new Set(); // /jobs/<id>-slug of every job already opened this run
function buildInjection(max = TARGET) {
  let raw = fs
    .readFileSync(path.join(__dirname, site.script), 'utf8')
    .replace(/DRY_RUN: true/, `DRY_RUN: ${!LIVE}`)
    .replace(/MAX_APPLICATIONS: \d+/, `MAX_APPLICATIONS: ${max}`);
  // external paused: don't hand control back every few company-site jobs, nobody drains the queue
  if (!EXTERNAL_ON) raw = raw.replace(/EXTERNAL_BATCH: \d+/, 'EXTERNAL_BATCH: 1000000');
  // the console script reads its personal data from window.__APPLY_CONFIG (from .env),
  // so no PII lives in the injected script itself. Ledger sites also get the excluded
  // job ids and the ledger's own jobId() so both sides compute identical ids.
  return `(async () => {
    if (window.__aaBusy) return; window.__aaBusy = true;
    window.__APPLY_CONFIG = ${JSON.stringify({ CV, geminiKey, seen: [...seenJobs], ...(run ? {
      excluded: [...new Set([...run.browserConfig().excluded, ...deferredIds])],
      // TEST: allow-listed job URLs are opened directly, before any search card
      directJobs: POLICY.directUrls.map((u) => ({ href: u, id: require('./naukri-ledger').jobId(u) })),
    } : {}) })};
    ${run ? `window.__aaJobId = ${require('./naukri-ledger').jobId.toString()};` : ''}
    try { await ${raw}
    } finally { window.__aaBusy = false; }
  })()`;
}

(async () => {
  // LIVE needs an explicit second yes: --confirm-live, or typing LIVE at an interactive prompt.
  if (MODE === 'LIVE' && !LOGIN_MODE && !POLICY.confirmed) {
    if (!process.stdin.isTTY) {
      log('Refusing LIVE: no --confirm-live and no interactive terminal to confirm in.');
      process.exit(1);
    }
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question('Type LIVE to submit REAL applications (anything else aborts): ', r));
    rl.close();
    if (answer.trim() !== 'LIVE') { log('LIVE not confirmed — aborting. Nothing was started.'); process.exit(1); }
    POLICY.confirmed = true;
  }
  if (MODE === 'LIVE' && !LOGIN_MODE) {
    log('==================================================');
    log('  LIVE — REAL APPLICATIONS WILL BE SUBMITTED');
    log('==================================================');
  }
  if (MODE === 'TEST') log(`TEST — real clicks ONLY for job ids: ${[...POLICY.allow].join(', ')}`);
  if (SCHEDULED && !LOGIN_MODE) {
    const hour = new Date().getHours();
    if (hour < ACTIVE_FROM || hour >= ACTIVE_UNTIL) {
      log(`Outside active hours (${ACTIVE_FROM}:00-${ACTIVE_UNTIL}:00) — skipping this run.`);
      return;
    }
    const jitterMs = Math.floor(Math.random() * 14 * 60 * 1000);
    log(`Scheduled run: waiting ${Math.round(jitterMs / 60000)} min before starting.`);
    await new Promise((r) => setTimeout(r, jitterMs));
  }
  if (!LOGIN_MODE && TARGET <= 0) {
    log(`Daily cap of ${DAILY_CAP} applications already reached (${dayState.count} today) — exiting.`);
    return;
  }
  const launch = () => chromium.launchPersistentContext(path.join(__dirname, site.profile), {
    slowMo: 1000,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false, // bot checks block headless; headed + minimised instead (same trick as naukri refresh)
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-backgrounding-occluded-windows', // keep timers full-speed while minimised
      '--disable-renderer-backgrounding',
      '--disable-popup-blocking', // naukri script opens each job in a popup it controls
      // A hidden run launches off-screen, because hiding can only happen once the
      // window exists — measured as a 1-3s flash of "about:blank - Google Chrome"
      // before the hide landed. --show and --minimize need a real on-screen origin
      // (Chrome otherwise reuses the old -32000 bounds saved in the profile).
      // show-windows.js moves a hidden window back into view before showing it.
      SHOW_WINDOW || MINIMIZE_ONLY || LOGIN_MODE
        ? '--window-position=0,0'
        : '--window-position=-32000,-32000',
    ],
  });

  // The window used to be parked at -32000,-32000. That hid it, but its taskbar
  // button then "restored" it to coordinates no monitor covers, so the run could
  // never be watched. Minimise instead: same out-of-the-way behaviour, but one
  // click on the taskbar brings it up. Pass --show to leave it on screen.
  // Hiding once at launch was not enough: the naukri script opens a job popup per job,
  // external applies open their own tabs, and each new window appears on screen. Sweep
  // continuously instead, so a run genuinely stays out of sight.
  //
  // The sweep is paused while show-windows.js has set its flag, so bringing the browser
  // up to watch it does not turn into a fight with a timer.
  let sweepTimer = null;
  const tuckAway = async (ctx) => {
    if (LOGIN_MODE || SHOW_WINDOW) return;
    const stow = MINIMIZE_ONLY ? minimizeBrowserWindows : hideBrowserWindows;
    const dir = path.join(__dirname, site.profile);
    const sweep = async () => {
      if (fs.existsSync(SHOW_FLAG)) return; // user asked to see it
      await stow(dir).catch(() => {});
    };
    await new Promise((r) => setTimeout(r, 1200)); // let the window actually exist
    await sweep();
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => { sweep(); }, 4000);
    sweepTimer.unref?.();
    ctx.once('close', () => { if (sweepTimer) clearInterval(sweepTimer); });
  };

  if (LOGIN_MODE) {
    const ctx = await launch();
    const mainPage = ctx.pages()[0] || (await ctx.newPage());
    await mainPage.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    log('Chrome is open — log in to the site, then CLOSE the browser window. The session is saved automatically.');
    await new Promise((res) => ctx.on('close', res));
    log('Login window closed. Session saved. Now test with: node auto-apply-runner.js ' + SITE_ARG);
    return;
  }

  if (run) log(`Ledger: ${run.today}/${DAILY_CAP} APPLIED today, ${run.excluded.size} job ids permanently excluded` +
    (EXTERNAL_ON ? '' : ' — company-site applies paused until they are ledger-recorded'));
  if (run && deferredIds.size) log(`Deferred company-site jobs excluded: ${deferredIds.size}`);
  log(`Starting. mode=${MODE === 'DRY' ? 'DRY RUN' : MODE} target=${TARGET} applications, max ${MAX_RUNTIME_MS / 60000} min`);
  const deadline = Date.now() + MAX_RUNTIME_MS;
  let submitted = 0;
  let lastActivity = Date.now();
  let searchIdx = 0;
  // resumePaging sites: pagination state lives here, outside session(), so a browser
  // restart resumes where the search tab was instead of at searches[0] page 1.
  let resumeUrl = null;          // last results URL the main search tab loaded
  let mainPageRef = null;        // the current session's search tab
  let pageAdvanced = false;      // in-page script clicked Next since the last supervisor tick
  let searchDone = false;        // in-page script reported "No more pages" for this search
  let searchesExhausted = false; // every search walked to its last page: stop, don't restart
  let pendingJob = null; // details of the job currently being applied to, for the CSV
  const externalQueue = [];              // "Apply on company site" jobs, handled in Node
  // Tabs opened purely to read the site's applied-list. They are on the same origin as
  // the feed, so without this the supervisor would inject the apply script into them.
  const VERIFY_PAGES = new Set();
  const externalSeen = new Set();
  const extStats = { applied: 0, skipped: 0, failed: 0 };

  const isBusy = (p) => p.evaluate('!!window.__aaBusy').catch(() => false);

  /**
   * Look the job up in the site's own applied-list after submitting it.
   * Returns 'verified' | 'missing' | 'unknown' ('unknown' when the check itself could
   * not run, which must never be reported as a failed application).
   * Opens its own tab, registered in VERIFY_PAGES so the apply script is not injected
   * into it, and always closes it.
   */
  /**
   * Every /jobs/<id>-slug currently listed on the site's applied page.
   * Best-effort: an empty list simply means no seeding, never a failed run.
   */
  async function collectAppliedSlugs(context) {
    if (!site.appliedListUrl || !context) return [];
    let page;
    try {
      page = await context.newPage();
      VERIFY_PAGES.add(page);
      await page.goto(site.appliedListUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(
        () => /Ongoing|Archived|No applications/i.test(document.body.innerText),
        { timeout: 30000 }
      ).catch(() => {});
      await page.waitForTimeout(2500);
      // Applied rows link as /jobs/applications/<applicationId>-<jobId>; the job id is
      // the second number. An earlier version matched /jobs/<digits>, which never fires
      // on this page and silently seeded nothing.
      return await page.evaluate(() =>
        [...new Set([...document.querySelectorAll('a[href*="/jobs/applications/"]')]
          .map((a) => (a.getAttribute('href') || '').match(/\/jobs\/applications\/\d+-(\d+)/))
          .filter(Boolean).map((m) => '/jobs/' + m[1]))]
      );
    } catch (e) {
      log(`  (could not read applied list: ${String(e.message || e).split(String.fromCharCode(10))[0].slice(0, 80)})`);
      return [];
    } finally {
      if (page) { VERIFY_PAGES.delete(page); await page.close().catch(() => {}); }
    }
  }

  async function verifyInAppliedList(job, context) {
    if (!site.appliedListUrl || !job || !context) return 'unknown';
    let page;
    try {
      // The browser context is taken from the caller's page: `ctx` is created inside
      // session() and is not in scope here, which made every verification throw
      // "ctx is not defined" and report a real application as unverified.
      page = await context.newPage();
      VERIFY_PAGES.add(page);
      await page.goto(site.appliedListUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // the list is client-rendered; wait for a row to exist rather than a fixed sleep
      await page.waitForFunction(
        () => /Ongoing|Archived|No applications/i.test(document.body.innerText),
        { timeout: 30000 }
      ).catch(() => {});
      await page.waitForTimeout(2500);
      const id = ((job.link || '').match(/\/jobs\/(\d+)/) || [])[1] || '';
      const company = (job.company || '').trim();
      return await page.evaluate(([id, company]) => {
        const html = document.body.innerHTML;
        const text = document.body.innerText;
        if (!/Ongoing|Archived|No applications/i.test(text)) return 'unknown'; // page never rendered
        // The job id is the strongest signal; the company name is the fallback for
        // rows that link by slug only.
        if (id && html.includes(id)) return 'verified';
        // Plain substring match: a company name is literal text, and building a
        // regex from it only invited escaping bugs.
        if (company.length > 2 && text.toLowerCase().includes(company.toLowerCase())) return 'verified';
        if (!id && !company) return 'unknown'; // nothing to match on
        return 'missing';
      }, [id, company]);
    } catch (e) {
      // Say why. A bare "unavailable" gave no way to tell a slow page from a tab that
      // had been closed out from under the check.
      log(`  (verification error: ${String(e.message || e).split('\n')[0].slice(0, 90)})`);
      return 'unknown';
    } finally {
      if (page) { VERIFY_PAGES.delete(page); await page.close().catch(() => {}); }
    }
  }

  // Every full navigation wipes window.__aaBusy, so a page that keeps navigating
  // (role/* search pages navigate on every job click) used to get a fresh script
  // injected each time — four instances raced, and the human-pace delay vanished.
  // One injection per 20s per run is plenty; the script itself loops internally.
  let lastInject = 0;
  const inject = async (page) => {
    if (Date.now() - lastInject < 20000) return;
    lastInject = Date.now();
    // ledger sites: the browser only learns what is left of THIS run
    await page.evaluate(buildInjection(run ? TARGET - submitted : TARGET)).catch(() => {}); // navigation mid-run is normal
  };

  /**
   * Reload the job in its own tab and read the Apply control. Only an explicit
   * "Applied" state on that job's own page counts — /myapply/ or success-sounding
   * text elsewhere never does. Returns 'applied' | 'not-applied' | 'unknown'.
   */
  async function verifyNaukriApplied(context, url) {
    const id = require('./naukri-ledger').jobId(url);
    let page;
    try {
      page = await context.newPage();
      VERIFY_PAGES.add(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const state = await page.waitForFunction(() => {
        // Naukri swaps the Apply button for <span id="already-applied">Applied</span>
        // inside the apply-button container (seen live 2026-09-28). Visible + exact text only.
        if ([...document.querySelectorAll('#already-applied, .already-applied')]
          .some((e) => e.offsetParent !== null && /^applied$/i.test(e.textContent.trim()))) return 'applied';
        const texts = [...document.querySelectorAll('button, a, [role="button"], #apply-button, [id*="apply" i]')]
          .filter((b) => b.offsetParent !== null)
          .map((b) => b.textContent.trim()).filter((t) => t && t.length < 40);
        if (texts.some((t) => /^applied\b/i.test(t))) return 'applied';
        if (texts.some((t) => /^apply(\s+now)?$/i.test(t) || /company site/i.test(t))) return 'not-applied';
        return null;
      }, null, { timeout: 30000, polling: 500 }).then((h) => h.jsonValue()).catch(() => 'unknown');
      // redirected (login wall, expired listing) → not this job's page, cannot vouch for it
      if (/^\d+$/.test(id) && !page.url().includes(id)) return 'unknown';
      return state;
    } catch (e) {
      log(`  (verification error: ${String(e.message || e).split('\n')[0].slice(0, 90)})`);
      return 'unknown';
    } finally {
      if (page) { VERIFY_PAGES.delete(page); await page.close().catch(() => {}); }
    }
  }

  /**
   * window.__aaReport({url, title, company, route, status, reason}) from the browser.
   * Returns {remaining} for THIS run; the browser loops on it. Counts move only after
   * reload verification and a successful ledger append.
   */
  async function onReport(source, r) {
    try {
      r = r || {};
      if (!LIVE) { // dry run: nothing is written, simulated applies still pace the run
        run.excluded.add(require('./naukri-ledger').jobId(r.url)); // in memory: don't re-walk it this run
        if (r.status === 'APPLIED' && r.reason !== 'already-applied') {
          submitted++;
          log(`==> ${submitted}/${TARGET} this run (dry run — not recorded)`);
        } else log(`  (dry run — would record ${r.status}: ${r.reason})`);
        return { remaining: TARGET - submitted };
      }
      const rid = require('./naukri-ledger').jobId(r.url);
      if (MODE === 'TEST' && !POLICY.allow.has(rid)) {
        // TEST writes the ledger only for its allow-listed jobs; anything else was never clicked
        run.excluded.add(rid);
        log(`  (TEST — ${rid} is not allow-listed; ${r.status}: ${r.reason} not recorded)`);
        return { remaining: testDone ? 0 : TARGET - submitted };
      }
      if (r.status === 'APPLIED') {
        const v = await verifyNaukriApplied(source.context, r.url);
        const already = r.reason === 'already-applied';
        if (v === 'applied') {
          const rec = run.record({ ...r, reason: already ? 'already-applied' : 'verified: Applied on reload' }, { count: !already });
          if (rec.counted) {
            submitted = run.submitted;
            dayState.count = run.today;
            log(`  ✔ verified — job page shows Applied`);
            log(`==> ${submitted}/${TARGET} this run (${run.today}/${DAILY_CAP} today)`);
            try { logApplication({ title: r.title, company: r.company, salary: '', skills: matchSkills(r.title || ''), link: rec.url, verified: 'verified', jd: '' }); }
            catch (e) { log('CSV write failed: ' + e.message); }
          } else log('  ↩ already applied before this run — recorded, not counted');
        } else {
          run.record({ ...r, status: 'FAILED', reason: `unverified (${v}) after: ${r.reason || ''}` });
          log(`  ❌ not verified (${v}) — recorded FAILED, not counted`);
        }
      } else if (r.status === 'FAILED' || r.status === 'SKIPPED') {
        run.record(r);
      }
      markTested(rid);
    } catch (e) {
      log('ledger/report error (nothing counted): ' + String(e.message || e).split('\n')[0]);
    }
    return { remaining: testDone ? 0 : TARGET - submitted };
  }

  /** window.__aaMayClick(jobId): the page asks before every real Apply click. */
  function onMayClick(source, id) {
    const ok = mayClick(POLICY, String(id || ''));
    log(`  🔒 click gate: ${id} → ${ok ? 'ALLOW' : 'DENY'} (${MODE})`);
    if (!ok && run) run.excluded.add(String(id)); // not again this run
    return ok;
  }

  function wire(page) {
    page.on('console', (msg) => {
      const text = msg.text();
      if (!/auto-apply/.test(text)) return;
      lastActivity = Date.now();
      const clean = text.replace(/%c\[auto-apply\]\s*\S*/, '').trim();
      log('  ' + clean.slice(0, 160));

      // snapshot the wizard whenever it can't proceed, so the blocking field is visible
      if (/no Continue\/Submit button found|no Send button found/.test(clean)) {
        page.screenshot({ path: path.join(__dirname, `blocked-step-${SITE_ARG}.png`) }).catch(() => {});
      }

      // "▶ Applying: <title> @ <company>" (wellfound) / "▶ Opening: <title>" (indeed)
      const m = clean.match(/▶ (?:Applying|Opening)[^:]*: (.+)/);
      if (m) {
        const [main, link, cardSalary] = m[1].split(' | ');
        const atParts = main.split(' @ ');
        const company = atParts.length > 1 ? atParts.pop() : ''; // company is after the LAST ' @ ' — titles may contain '@'
        const title = atParts.join(' @ ');
        // Key on the numeric job id alone. Keying on the full slug meant an id seeded
        // from the applied list (/jobs/4662968) never matched a feed link
        // (/jobs/4662968-software-engineer), so seeding had no effect.
        const idm = (link || main).match(/\/jobs\/(\d+)/);
        const slug = idm ? '/jobs/' + idm[1] : undefined;
        if (slug) seenJobs.add(slug); // page storage is wiped across navigations; Node keeps it
        pendingJob = { title: title.trim(), company: (company || '').replace(/^\?$/, '').trim(), link: (link || '').trim(), salary: (cardSalary || '').trim(), skills: '', jd: '' };
        // scrape details once the job pane/description has rendered
        setTimeout(() => {
          page.evaluate(() => {
            const q = (s) => document.querySelector(s)?.textContent?.trim() || '';
            return {
              company: (document.body.innerText.match(/Apply to (.{2,60})/) || [])[1]?.trim() ||
                q('[data-testid="inlineHeader-companyName"]') || q('[data-company-name]') || q('a[href^="/company/"]'),
              salary: q('#salaryInfoAndJobType') || q('[data-testid*="salary" i]') ||
                (document.body.innerText.match(/(?:₹|\$)\s?[\d,.]+(?:\s?-\s?(?:₹|\$)?[\d,.]+)?[^\n]{0,30}/) || [''])[0],
              jd: (q('#jobDescriptionText') || q('[class*="jobDescription" i]') || q('[class*="description" i]')).slice(0, 1200),
            };
          }).then((d) => {
            if (!d || !pendingJob) return;
            pendingJob.company = pendingJob.company || d.company;
            pendingJob.salary = pendingJob.salary || d.salary;
            pendingJob.jd = d.jd;
            pendingJob.skills = matchSkills(pendingJob.title + ' ' + d.jd);
          }).catch(() => {});
        }, SITE_ARG === 'indeed' ? 6000 : 2000); // indeed pane loads slower; wellfound modal closes fast
      }

      // "🔗 EXTERNAL | <title> | <href>" — the console script can't cross origins,
      // so queue it and let applyExternal() drive the company site from Node.
      if (site.resumePaging) {
        // A Next click is real progress; let the reload inject at once instead of
        // waiting out the 20s throttle and the next 45s supervisor tick.
        if (/🌐 Next results page/.test(clean)) { pageAdvanced = true; lastInject = 0; }
        if (/No more pages/.test(clean)) searchDone = true;
      }

      const ext = clean.match(/🔗 EXTERNAL \| (.+) \| (\S+)/);
      // ledger sites: don't re-offer a handed-off job to later injections of this run
      if (ext && run) {
        const eid = require('./naukri-ledger').jobId(ext[2]);
        run.excluded.add(eid);
        if (LIVE && !deferredIds.has(eid)) { // dry runs write nothing
          try {
            if (deferred.defer({ url: ext[2], title: ext[1].trim() }, deferred.DEFERRED, deferredIds)) log(`  ↪ deferred company-site job ${eid} (naukri-deferred.jsonl)`);
          } catch (e) { log('deferred write failed: ' + e.message); }
        }
        markTested(eid);
      }
      if (ext && !externalSeen.has(ext[2])) {
        externalSeen.add(ext[2]);
        externalQueue.push({ title: ext[1].trim(), href: ext[2].trim() });
      }

      // ledger sites count through __aaReport only; the log line is just a log line
      if (!run && site.submittedRe.test(text)) {
        submitted++;
        log(`==> ${submitted}/${TARGET} this run (${dayState.count + (LIVE ? 1 : 0)}/${DAILY_CAP} today)`);
        if (LIVE) { // dry runs don't pollute the CSV or the daily count
          bumpDayCount();
          const job = pendingJob || { title: 'unknown' };
          // Verify against the site's own applied-list before writing the CSV row, so
          // the CSV records what actually registered rather than what we hoped did.
          verifyInAppliedList(job, page.context()).then((v) => {
            job.verified = v;
            if (v === 'verified') log(`  ✔ verified — job is in ${SITE_ARG}'s applied list`);
            else if (v === 'missing') log(`  ❌ NOT in ${SITE_ARG}'s applied list — the submission did not register`);
            else log('  ? verification unavailable — CSV row marked unverified');
            try { logApplication(job); } catch (e) { log('CSV write failed: ' + e.message); }
          });
        }
        pendingJob = null;
      }
    });
    // Naukri's Next is a client-side navigation: the URL changes but no 'load' fires
    // (measured 2026-09-28). framenavigated sees both kinds, so it records the page for
    // resuming after a restart and, after a Next, injects once the new results settle.
    if (site.resumePaging) page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || page !== mainPageRef || VERIFY_PAGES.has(page)) return;
      const url = page.url();
      if (!site.injectOn(url) || url === resumeUrl) return;
      resumeUrl = url;
      log(`📄 page: ${url}`);
      if (pageAdvanced) {
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
          .then(() => page.waitForTimeout(1500))
          .then(() => inject(page)).catch(() => {}); // lastInject was reset by the Next line
      }
    });
    page.on('load', async () => {
      if (VERIFY_PAGES.has(page)) return; // verification tab: same origin, must stay untouched
      if (!site.injectOn(page.url())) return;
      lastActivity = Date.now();
      // daily reset of the console script's submit counter (persists in localStorage)
      if (site.storeKey) {
        await page.evaluate(([key, today, reset]) => {
          try {
            const s = JSON.parse(localStorage.getItem(key) || '{}');
            if (s.day !== today || reset) {
              s.day = today; s.submitted = 0; s.applied = 0;
              s.seen = (s.seen || []).slice(-2000);
              s.seenDry = (s.seenDry || []).slice(-2000); // dry runs keep their own list
              localStorage.setItem(key, JSON.stringify(s));
            }
          } catch (e) {}
        }, [site.storeKey, new Date().toDateString(), process.argv.includes('--reset-counter')]).catch(() => {});
      }
      await inject(page);
    });
  }

  // One browser session. Returns as soon as it stops making progress (searches
  // exhausted, page wedged, crash) — the caller then closes and reopens the browser.
  async function session() {
  const ctx = await launch();
  await tuckAway(ctx);
  if (run) {
    await ctx.exposeBinding('__aaReport', onReport);
    await ctx.exposeBinding('__aaMayClick', onMayClick);
  }

  // Seed the seen-list from the site's own applied list. The in-page list lives in
  // localStorage that wellfound's role/job pages do not share across navigations, and
  // Node's copy resets whenever the browser is reopened — so a restarted run walked
  // straight back into jobs it had already applied to (observed re-opening the Edmo
  // job it applied to 20 minutes earlier). Those cost a full cycle each and produce
  // no application, which then trips the "3 fruitless cycles" restart, which resets
  // the list again. Seeding from the authoritative list breaks that loop.
  if (site.appliedListUrl && !LOGIN_MODE) {
    const before = seenJobs.size;
    const found = await collectAppliedSlugs(ctx);
    for (const slug of found) seenJobs.add(slug);
    if (seenJobs.size > before) log(`Seeded ${seenJobs.size - before} already-applied jobs from ${site.appliedListUrl}`);
  }
  const mainPage = ctx.pages()[0] || (await ctx.newPage());
  mainPageRef = mainPage;
  if (!site.resumePaging) searchIdx = 0;
  lastActivity = Date.now();
  let fruitless = 0;            // consecutive script cycles that applied to nothing
  let submittedAtCycle = submitted;
  try {
  ctx.pages().forEach(wire);
  ctx.on('page', wire);

  const startUrl = (site.resumePaging && resumeUrl) || site.searches[site.resumePaging ? searchIdx : 0];
  if (site.resumePaging && resumeUrl) log(`Resuming search ${searchIdx + 1}/${site.searches.length} at ${resumeUrl}`);
  await mainPage.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // not logged in? every flow needs a session — bail with a clear message
  await mainPage.waitForTimeout(8000);
  const bodyText = await mainPage.evaluate('document.body.innerText.slice(0, 3000)').catch(() => '');
  if (/sign in|log in to continue|create an account|verify you are human/i.test(bodyText) && !/sign out/i.test(bodyText)) {
    log('WARNING: page looks logged-out or bot-checked. If runs keep finding 0 jobs, run: node auto-apply-runner.js ' + SITE_ARG + ' login');
  }
  await inject(mainPage);

  // Supervisor: re-inject the search tab when idle, close finished form tabs,
  // rotate searches on inactivity, stop on target/time.
  while (submitted < TARGET && Date.now() < deadline && !testDone) {
    await new Promise((r) => setTimeout(r, 45000));

    const pages = ctx.pages();
    let anyBusy = false;
    for (const p of pages) {
      // A verification tab is same-origin with the feed, so both close-rules below
      // match it. Closing it mid-check made verifyInAppliedList() throw and report
      // "verification unavailable" for an application that had in fact registered.
      if (VERIFY_PAGES.has(p)) continue;
      if (await isBusy(p)) anyBusy = true;
      // finished smartapply/form tabs: close them so tabs don't pile up
      if (p !== mainPage && /smartapply|\/apply/.test(p.url()) && !(await isBusy(p))) {
        await p.close().catch(() => {});
      }
      // live mode: after submit the form tab returns to search — close that duplicate search tab
      if (p !== mainPage && site.injectOn(p.url()) && !/smartapply|\/apply/.test(p.url()) && !(await isBusy(p))) {
        await p.close().catch(() => {});
      }
    }

    // Work the external queue whenever the in-page script is idle, so the two
    // never drive the browser at the same time.
    while (EXTERNAL_ON && !anyBusy && externalQueue.length && submitted < TARGET && Date.now() < deadline) {
      const job = externalQueue.shift();
      log(`🔗 external: ${job.title}`);
      const res = await applyExternal(ctx, job, { CV, live: LIVE, resumePath: RESUME_PATH, log });
      lastActivity = Date.now();
      log(`   ${res.status}: ${res.detail}`);
      if (res.status === 'applied' || res.status === 'would-apply') {
        extStats.applied++;
        submitted++;
        log(`==> ${submitted}/${TARGET} this run (${dayState.count + (LIVE ? 1 : 0)}/${DAILY_CAP} today)`);
        if (LIVE) {
          bumpDayCount();
          try { logApplication({ title: job.title, company: '', salary: '', skills: matchSkills(job.title), link: job.href, jd: 'external (company site)' }); }
          catch (e) { log('CSV write failed: ' + e.message); }
        }
      } else extStats[res.status === 'skipped' ? 'skipped' : 'failed']++;
      await new Promise((r) => setTimeout(r, 20000 + Math.random() * 25000)); // human-ish gap
    }

    if (!anyBusy) {
      if (searchDone || Date.now() - lastActivity > IDLE_ROTATE_MS) {
        if (searchDone) log(`Search ${searchIdx + 1}/${site.searches.length} has no more pages.`);
        searchDone = false;
        resumeUrl = null;
        searchIdx++;
        if (searchIdx >= site.searches.length) {
          log('All searches exhausted for today.');
          if (site.resumePaging) searchesExhausted = true; // nothing left: a restart would only loop
          break;
        }
        log(`Rotating to next search: ${site.searches[searchIdx]}`);
        if (site.resumePaging) lastInject = 0; // the new search's first page injects on load
        await mainPage.goto(site.searches[searchIdx], { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      } else {
        // Re-injecting forever in a wedged browser looks like progress but isn't:
        // a bot-check, a dead SPA or a stale session produce the same "script ran,
        // applied nothing" cycle every time. After 3 fruitless cycles, hand back to
        // the caller so the browser is closed and reopened fresh.
        // A cycle that paged forward is progress too: a run of pages with nothing to
        // apply to is normal once many jobs are excluded, not a wedged browser.
        if (submitted === submittedAtCycle && !pageAdvanced) {
          if (++fruitless >= 3) {
            log('No applications in 3 script cycles — closing the browser and reopening.');
            return;
          }
        } else { fruitless = 0; submittedAtCycle = submitted; }
        pageAdvanced = false;
        await inject(mainPage); // continue with next job on this page
      }
    }
  }
  } finally {
    await ctx.close().catch(() => {});
  }
  }

  // Close-and-reopen loop: a session that ends early (feed exhausted, tab wedged,
  // browser crash) costs a fresh browser, not the run. `submitted` and `deadline`
  // live outside, so restarts resume toward the same 30 rather than starting over.
  for (let attempt = 1; submitted < TARGET && Date.now() < deadline && !testDone; attempt++) {
    if (attempt > 1) log(`↻ Reopening browser (attempt ${attempt}/${MAX_RESTARTS}) — ${submitted}/${TARGET} done so far`);
    try {
      await session();
    } catch (e) {
      const msg = String(e && e.message || e).split('\n')[0];
      log('session ended with an error: ' + msg);
      // A previous Chrome still holding the profile is a wait-it-out problem, not a
      // dead run — don't spend one of the 8 restarts (and 8 of them burned in 2 min).
      if (/already in use|Opening in existing browser/i.test(msg)) {
        attempt--;
        log('profile still locked by another Chrome — waiting 30s');
        await new Promise((r) => setTimeout(r, 30000));
        continue;
      }
    }
    if (submitted >= TARGET || Date.now() >= deadline || searchesExhausted || testDone) break;
    if (attempt >= MAX_RESTARTS) { log(`Stopping after ${MAX_RESTARTS} browser restarts — no more jobs to apply to.`); break; }
    await new Promise((r) => setTimeout(r, 15000)); // let the profile lock clear before relaunching
  }

  log(`Finished: ${submitted}/${TARGET} applications ${LIVE ? 'submitted' : 'simulated (dry run)'}.`);
  if (surfacedErrors) log(`⚠ ${surfacedErrors} unexpected error(s) were logged during this run — see ERROR lines above.`);
  if (site.externalApply) {
    log(`External (company site): ${extStats.applied} applied, ${extStats.skipped} skipped (account required / not a form), ` +
        `${extStats.failed} failed, ${externalQueue.length} left in queue.`);
  }
})().catch((e) => { log('FATAL: ' + e.message.split('\n')[0]); process.exit(1); });










