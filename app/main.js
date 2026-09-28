/**
 * ApplyIt desktop app — Electron main process.
 *
 * The Naukri engine is NOT rewritten: the app forks the existing CLI runner
 * (auto-apply-runner.js naukri …) and talks to it over child_process IPC:
 *   runner → app   {type:'event', event, snapshot}      (run-events.js)
 *   app → runner   {type:'control', action: pause|resume|stop}
 * Mode safety is the runner's own (safety.js): the app only builds the same CLI flags a
 * user would type, and LIVE is passed only after the user typed LIVE in the window.
 *
 *   npm run app                 open the app
 *   npm run app -- --selftest   DRY run + pause/resume/stop, then exit (0 = pass)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'auto-apply-runner.js');
const PROFILE_DIR = path.join(ROOT, '.naukri-apply-profile');
const data = require('./data');
const ledger = require('../naukri-ledger');
const history = require('../naukri-history');
const deferred = require('../naukri-deferred');
const { restoreBrowserWindows, hideBrowserWindows, SHOW_FLAG } = require('../window-utils');

const SELFTEST = process.argv.includes('--selftest');
let win = null;
let child = null;
let lastSnapshot = null;
let lastMode = 'DRY';
const recentEvents = [];

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const files = () => ({ ledger: ledger.load(), history: history.load(), deferred: deferred.load() });

const { runnerArgs } = require('./run-args');
const { aiPreflight } = require('../safety');

async function startRun(opts, { forcedCheck } = {}) {
  if (child) return { ok: false, error: 'a run is already in progress' };
  let spec;
  try { spec = runnerArgs(opts); } catch (e) { return { ok: false, error: e.message }; }
  // same AI check as the runner (which repeats it): TEST/LIVE never start without working AI.
  // forcedCheck exists only so the self-test can prove the refusal without any real key.
  let warning = null;
  if (spec.mode !== 'DRY') {
    const checks = forcedCheck || await makeAi().check();
    const pf = aiPreflight(spec.mode, checks);
    if (!pf.ok) return { ok: false, error: pf.reason };
    if (forcedCheck) return { ok: false, error: 'self-test: forced check passed — not starting' }; // never fork from a test
    warning = pf.warning;
  }
  if (child) return { ok: false, error: 'a run is already in progress' };
  lastMode = spec.mode;
  recentEvents.length = 0;
  lastSnapshot = null;
  // Electron's own binary runs the runner as plain Node
  child = fork(RUNNER, spec.args, { cwd: ROOT, silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const lines = (buf) => String(buf).split(/\r?\n/).filter((l) => l.trim()).forEach((l) => send('run:log', l));
  child.stdout.on('data', lines);
  child.stderr.on('data', lines);
  child.on('message', (m) => {
    if (!m || m.type !== 'event') return;
    lastSnapshot = m.snapshot;
    recentEvents.push(m.event);
    if (recentEvents.length > 300) recentEvents.shift();
    send('run:event', m);
    selftestOnEvent(m);
  });
  child.on('exit', (code) => {
    send('run:exit', { code });
    child = null;
    selftestOnExit(code);
  });
  send('run:log', `▶ started: node auto-apply-runner.js ${spec.args.join(' ')}`);
  if (warning) send('run:log', `⚠ ${warning}`);
  return { ok: true, mode: spec.mode, warning };
}

function control(action) {
  if (!child || !['pause', 'resume', 'stop'].includes(action)) return { ok: false };
  child.send({ type: 'control', action });
  return { ok: true };
}

async function browserVisibility(show) {
  if (show) {
    try { fs.writeFileSync(SHOW_FLAG, new Date().toISOString()); } catch (e) { /* ignore */ }
    return { ok: true, windows: await restoreBrowserWindows(PROFILE_DIR) };
  }
  try { fs.unlinkSync(SHOW_FLAG); } catch (e) { /* ignore */ }
  return { ok: true, windows: await hideBrowserWindows(PROFILE_DIR) };
}

ipcMain.handle('run:start', (_e, opts) => startRun(opts));
ipcMain.handle('run:control', (_e, action) => control(action));
ipcMain.handle('browser:visibility', (_e, show) => browserVisibility(!!show));
ipcMain.handle('data:dashboard', () => {
  const recs = ledger.load();
  return { running: !!child, mode: lastMode, snapshot: lastSnapshot, events: recentEvents.slice(-80),
    today: ledger.todayApplied(recs), dailyCap: 50, perRun: 10, excluded: ledger.excludedIds(recs).size,
    aiToday: data.aiCallsToday(history.load()), aiStatus: makeAi().status(),
    inboxCount: require('../question-inbox').buildInbox(history.load(), (() => { const p = resumeProfile.load() || {};
      return { answeredByYou: p.answeredByYou || [], dontAnswer: p.dontAnswer || [] }; })()).length };
});
ipcMain.handle('data:applications', () => data.buildApplications(files()));
ipcMain.handle('data:job', (_e, id) => data.jobDetails(files(), String(id)));
ipcMain.handle('data:reports', () => data.buildReports(files()));

// ---------------------------------------------------------------- Setup (profile + preferences)
const resumeProfile = require('../resume-profile');
const preferences = require('../preferences');
const cfg = () => { delete require.cache[require.resolve('../config')]; return require('../config'); }; // .env may change
/** The same Gemini → Groq chain the runner uses; app-side AI calls are recorded in history too. */
function makeAi() {
  const { createAi, aiConfig } = require('../ai-providers');
  return createAi(aiConfig(cfg()), { onCall: (c) => { try { history.append({ type: 'ai-call', runId: 'app', mode: 'SETUP', ...c }); } catch (e) { /* ignore */ } } });
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const strs = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
/** Only known fields, only strings — the renderer's input is never trusted as-is. */
function sanitizeProfile(p = {}) {
  const u = p.userProvided || {};
  return {
    name: str(p.name), email: str(p.email), phone: str(p.phone), location: str(p.location), headline: str(p.headline),
    skills: strs(p.skills), tools: strs(p.tools), languages: strs(p.languages), certifications: strs(p.certifications),
    jobs: (Array.isArray(p.jobs) ? p.jobs : []).map((j) => ({ title: str(j.title), employer: str(j.employer), start: str(j.start), end: str(j.end) })).filter((j) => j.title || j.employer),
    education: (Array.isArray(p.education) ? p.education : []).map((e) => ({ degree: str(e.degree), institution: str(e.institution), year: str(e.year) })).filter((e) => e.degree || e.institution),
    projects: (Array.isArray(p.projects) ? p.projects : []).map((x) => ({ name: str(x.name), description: str(x.description) })).filter((x) => x.name),
    userProvided: {
      ...Object.fromEntries(resumeProfile.APP_FACTS.map((f) => [f.key, str(u[f.key])])),
      totalExperienceYears: str(u.totalExperienceYears),
    },
    resumeFile: str(p.resumeFile), resumeText: typeof p.resumeText === 'string' ? p.resumeText.slice(0, 60000) : '',
  };
}
ipcMain.handle('setup:load', () => {
  const profile = resumeProfile.load();
  const prefs = preferences.load();
  return {
    profile, prefs, hasKey: !!(cfg().geminiKey || cfg().groqKey),
    model: Object.entries(makeAi().status()).filter(([, s]) => s.configured).map(([n, s]) => `${n} ${s.model}`).join(' → ') || 'none',
    max: preferences.MAX,
    appFacts: resumeProfile.APP_FACTS.map(({ key, label }) => ({ key, label })),
    // where each application fact currently comes from (setup / resume / env / none)
    factSources: resumeProfile.applicationFacts(profile, prefs, cfg().CV).sources,
    // pre-fill for the 3 required steps: titles / keywords / locations from the resume
    suggestions: resumeProfile.suggestPreferences(profile),
  };
});
ipcMain.handle('setup:pickResume', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, { title: 'Select your resume (PDF)', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('setup:extract', async (_e, file) => {
  try {
    if (!/\.pdf$/i.test(String(file)) || !fs.existsSync(file)) return { ok: false, error: 'choose a PDF file' };
    const text = await resumeProfile.extractPdfText(file);
    if (!text) return { ok: false, error: 'no text found in this PDF (is it a scanned image?)' };
    const c = cfg();
    const r = await resumeProfile.buildProfile(text, { ai: (c.geminiKey || c.groqKey) ? makeAi() : null });
    return { ok: true, ...r, profile: { ...r.profile, resumeFile: file, resumeText: text } };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// The inbox choices live in profile.json but are never edited by the Setup form: carry
// them over on every profile save (sanitizeProfile would otherwise drop them).
const keepInbox = (next) => {
  const cur = resumeProfile.load() || {};
  return { ...next, answeredByYou: cur.answeredByYou || [], dontAnswer: cur.dontAnswer || [] };
};
ipcMain.handle('setup:saveProfile', (_e, p) => ({ ok: true, profile: resumeProfile.save(keepInbox(sanitizeProfile(p))) }));
// Setup and Settings each save only their part: merge into what's already saved
ipcMain.handle('setup:savePrefs', (_e, p) => {
  const saved = preferences.save({ ...(preferences.load() || {}), ...(p || {}) });
  return { ok: true, prefs: saved, searches: preferences.buildSearches(saved) };
});

// ---------------------------------------------------------------- "Needs your answer" inbox
const inbox = require('../question-inbox');
const savedChoices = (p) => ({ answeredByYou: (p && p.answeredByYou) || [], dontAnswer: (p && p.dontAnswer) || [] });
function inboxView() {
  const p = resumeProfile.load();
  return { open: inbox.buildInbox(history.load(), savedChoices(p)),
    answered: savedChoices(p).answeredByYou, declined: savedChoices(p).dontAnswer };
}
function inboxUpdate(key, fn) {
  const group = inbox.buildInbox(history.load(), savedChoices(resumeProfile.load())).find((g) => g.key === key);
  if (!group) return { ok: false, error: 'this question is no longer in the inbox' };
  try { resumeProfile.save(fn(resumeProfile.load() || {}, group)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, ...inboxView() };
}
ipcMain.handle('inbox:list', () => inboxView());
ipcMain.handle('inbox:answer', (_e, { key, answer } = {}) => inboxUpdate(String(key), (p, g) => inbox.saveAnswer(p, g, answer)));
ipcMain.handle('inbox:dont', (_e, { key } = {}) => inboxUpdate(String(key), (p, g) => inbox.dontAnswer(p, g)));
ipcMain.handle('inbox:forget', (_e, { key } = {}) => {
  const p = resumeProfile.load();
  if (p) resumeProfile.save(inbox.forget(p, String(key)));
  return { ok: true, ...inboxView() };
});
ipcMain.handle('setup:previewSearches', (_e, p) => preferences.buildSearches(preferences.normalize(p)));

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 900, minHeight: 600, title: 'ApplyIt',
    show: !SELFTEST || process.argv.includes('--show-window'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (SELFTEST) win.webContents.once('did-finish-load', selftestStart);
}

// Closing the window stops a run cleanly (the current job is recorded first).
let quitting = false;
app.on('before-quit', (e) => {
  if (!child || quitting) return;
  e.preventDefault();
  quitting = true;
  control('stop');
  const t = setTimeout(() => child && child.kill(), 120000);
  child.once('exit', () => { clearTimeout(t); app.quit(); });
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- self-test (DRY only)
// Opens the real window, starts a DRY run through the same IPC the buttons use, then
// pauses, resumes and stops it, and checks the Running page rendered what happened.
let st = null;
async function selftestStart() {
  st = { step: 'wait-job', seen: [], timer: setTimeout(() => selftestDone(false, 'timeout'), 300000) };
  // TEST/LIVE must be refused when the AI check fails (forced failure: nothing can start)
  const t = await startRun({ mode: 'TEST', only: '123456789012' }, { forcedCheck: { gemini: { ok: false, reason: 'self-test forced failure' }, groq: { ok: false, reason: 'self-test forced failure' } } });
  const l = await startRun({ mode: 'LIVE', confirmText: 'LIVE' }, { forcedCheck: { gemini: { ok: false, reason: 'self-test forced failure' }, groq: { ok: false, reason: 'self-test forced failure' } } });
  st.refused = !t.ok && !l.ok && /working AI provider/.test(t.error) && /working AI provider/.test(l.error) && !child;
  const r = await startRun({ mode: 'DRY' });
  if (!r.ok) selftestDone(false, r.error);
}
function selftestOnEvent(m) {
  if (!st) return;
  const s = m.event.state;
  st.seen.push(s);
  if (st.step === 'wait-job' && ['would-apply', 'deferred'].includes(s)) { st.step = 'pausing'; control('pause'); }
  else if (st.step === 'pausing' && s === 'paused') {
    st.step = 'paused';
    setTimeout(async () => {
      st.pausedUi = await win.webContents.executeJavaScript("document.getElementById('run-state').textContent");
      st.step = 'resuming'; control('resume');
    }, 3000);
  } else if (st.step === 'resuming' && s === 'resumed') { st.step = 'stopping'; control('stop'); }
}
async function selftestOnExit(code) {
  if (!st) return;
  const ui = await win.webContents.executeJavaScript(`({
    state: document.getElementById('run-state').textContent,
    events: document.querySelectorAll('#event-list li').length,
    job: document.getElementById('cur-job').textContent,
    tallies: document.getElementById('tallies').textContent.replace(/\\s+/g, ' ').trim(),
  })`).catch((e) => ({ error: e.message }));
  // Setup path inside Electron: pdfjs extraction of the configured resume (read-only, length only)
  let resumeChars = null;
  try { const rf = cfg().resumePath; if (rf && fs.existsSync(rf)) resumeChars = (await resumeProfile.extractPdfText(rf)).length; } catch (e) { resumeChars = `error: ${e.message}`; }
  ui.setupLoaded = await win.webContents.executeJavaScript("document.querySelector('.nav-btn[data-page=\"setup\"]').click(); new Promise(r => setTimeout(() => r(!!(document.getElementById('s-titles') && document.getElementById('s-locs') && document.getElementById('setup-save') && document.querySelector('details#more:not([open])'))), 1500))").catch(() => false);
  ui.inboxShown = await win.webContents.executeJavaScript("!!document.getElementById('inbox-count') && document.getElementById('inbox-count').textContent !== ''").catch(() => false);
  ui.advancedDefaultsOff = await win.webContents.executeJavaScript("document.querySelector('.nav-btn[data-page=\"settings\"]').click(); new Promise(r => setTimeout(() => r(!!document.getElementById('advanced') && !document.getElementById('advanced').open), 800))").catch(() => false);
  ui.resumeChars = resumeChars;
  const need = ['starting', 'searching', 'checking-job', 'paused', 'resumed', 'stopped'];
  const missing = need.filter((s) => !st.seen.includes(s));
  const ok = code === 0 && !missing.length && /PAUSED/i.test(st.pausedUi || '') && /STOPPED/i.test(ui.state || '') && ui.events > 5
    && ui.setupLoaded === true && ui.inboxShown === true && ui.advancedDefaultsOff === true
    && (resumeChars === null || typeof resumeChars === 'number') && st.refused === true;
  ui.testLiveRefusedWithoutAi = st.refused;
  // --capture=<dir>: save a screenshot of each page (needs --show-window to render)
  const cap = (process.argv.find((a) => a.startsWith('--capture=')) || '').slice(10);
  if (cap) {
    for (const p of ['dashboard', 'running', 'applications', 'reports', 'settings', 'setup']) {
      await win.webContents.executeJavaScript(`document.querySelector('.nav-btn[data-page="${p}"]').click()`);
      await new Promise((r) => setTimeout(r, 1200));
      fs.writeFileSync(path.join(cap, `app-${p}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // display-only sample of the inbox (no history yet has skipped questions); nothing is saved
    await win.webContents.executeJavaScript(`document.querySelector('.nav-btn[data-page="dashboard"]').click();`);
    await new Promise((r) => setTimeout(r, 1500)); // let the real inbox load finish first
    await win.webContents.executeJavaScript(`window.ApplyItInbox.render({ open: [
        { key: 'a', question: 'Are you willing to work night shifts?', options: ['Yes', 'No'], missing: ['shift preference'], jobs: [{ jobId: '1', title: 'Data Analyst', company: 'Acme' }, { jobId: '2', title: 'BI Analyst', company: 'Beta' }] },
        { key: 'b', question: 'How many years of experience do you have with Tableau?', options: [], missing: ['Tableau experience'], jobs: [{ jobId: '3', title: 'Data Analyst', company: 'Gamma' }] } ],
        answered: [{ key: 'c', question: 'What is your notice period?', answer: '30 days' }], declined: [] });
      document.getElementById('inbox-panel').scrollIntoView();`);
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(path.join(cap, 'app-inbox-sample.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('.nav-btn[data-page="settings"]').click(); document.getElementById('advanced').open = true;`);
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(path.join(cap, 'app-settings-advanced.png'), (await win.webContents.capturePage()).toPNG());
  }
  selftestDone(ok, JSON.stringify({ runnerExit: code, missing, pausedUi: st.pausedUi, ui, states: [...new Set(st.seen)] }));
}
function selftestDone(ok, detail) {
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.timer);
  console.log(`SELFTEST ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (child) { child.kill(); }
  app.exit(ok ? 0 : 1);
}
