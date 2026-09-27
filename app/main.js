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

function startRun(opts) {
  if (child) return { ok: false, error: 'a run is already in progress' };
  let spec;
  try { spec = runnerArgs(opts); } catch (e) { return { ok: false, error: e.message }; }
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
  return { ok: true, mode: spec.mode };
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
    today: ledger.todayApplied(recs), dailyCap: 50, perRun: 10, excluded: ledger.excludedIds(recs).size };
});
ipcMain.handle('data:applications', () => data.buildApplications(files()));
ipcMain.handle('data:job', (_e, id) => data.jobDetails(files(), String(id)));
ipcMain.handle('data:reports', () => data.buildReports(files()));

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
function selftestStart() {
  st = { step: 'wait-job', seen: [], timer: setTimeout(() => selftestDone(false, 'timeout'), 300000) };
  const r = startRun({ mode: 'DRY' });
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
  const need = ['starting', 'searching', 'checking-job', 'paused', 'resumed', 'stopped'];
  const missing = need.filter((s) => !st.seen.includes(s));
  const ok = code === 0 && !missing.length && /PAUSED/i.test(st.pausedUi || '') && /STOPPED/i.test(ui.state || '') && ui.events > 5;
  // --capture=<dir>: save a screenshot of each page (needs --show-window to render)
  const cap = (process.argv.find((a) => a.startsWith('--capture=')) || '').slice(10);
  if (cap) {
    for (const p of ['dashboard', 'running', 'applications', 'reports', 'settings', 'setup']) {
      await win.webContents.executeJavaScript(`document.querySelector('.nav-btn[data-page="${p}"]').click()`);
      await new Promise((r) => setTimeout(r, 1200));
      fs.writeFileSync(path.join(cap, `app-${p}.png`), (await win.webContents.capturePage()).toPNG());
    }
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
