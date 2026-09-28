/* ApplyIt renderer — plain JS. All data is inserted with textContent, never innerHTML. */
'use strict';
const api = window.applyit;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '');
const LABEL = { 'checking-job': 'Checking job', 'opening-application': 'Opening application', 'generating-answer': 'Generating answer',
  'filling-answer': 'Filling answer', 'loading-results': 'Loading results', 'application-verified': 'Application verified',
  'already-applied': 'Already applied', 'would-apply': 'Would apply (dry run)', 'ai-matching': 'AI matching' };
const label = (s) => LABEL[s] || (s ? s[0].toUpperCase() + s.slice(1).replace(/-/g, ' ') : '');
const CAT = { APPLIED: 'Applied', ALREADY_APPLIED: 'Already applied', SKIPPED: 'Skipped', FAILED: 'Failed', DEFERRED: 'Deferred' };

// ---------------------------------------------------------------- navigation
const pages = ['dashboard', 'setup', 'running', 'applications', 'reports', 'settings', 'job'];
function show(page) {
  for (const p of pages) $(`page-${p}`).classList.toggle('hidden', p !== page);
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  if (page === 'applications') loadApplications();
  if (page === 'reports') loadReports();
  if (page === 'dashboard') { refreshDashboard(); if (window.ApplyItInbox) window.ApplyItInbox.load(); }
  if (page === 'setup' && window.ApplyItSetup) window.ApplyItSetup.load();
  if (page === 'settings') loadAdvanced();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.page)));

// ---------------------------------------------------------------- mode (resets to DRY each launch)
const settings = { mode: 'DRY' };
function currentMode() { return document.querySelector('input[name=mode]:checked').value; }
function syncMode() {
  settings.mode = currentMode();
  $('test-ids').disabled = settings.mode !== 'TEST';
  $('live-confirm').disabled = settings.mode !== 'LIVE';
  $('nav-mode').textContent = settings.mode;
  $('live-banner').classList.toggle('hidden', settings.mode !== 'LIVE' && runMode !== 'LIVE');
  $('mode-error').textContent = '';
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncMode));

// ---------------------------------------------------------------- run state
let running = false;
let runMode = null;
let snapshot = null;

async function start() {
  const opts = { mode: settings.mode, showBrowser: $('show-browser').checked };
  if (opts.mode === 'TEST') opts.only = $('test-ids').value;
  if (opts.mode === 'LIVE') opts.confirmText = $('live-confirm').value.trim();
  const r = await api.start(opts);
  if (!r.ok) { $('mode-error').textContent = r.error; show('settings'); return; }
  running = true; runMode = r.mode;
  $('event-list').textContent = ''; $('log').textContent = '';
  $('live-banner').classList.toggle('hidden', runMode !== 'LIVE');
  setControls();
  show('running');
}
function setControls() {
  const paused = !!(snapshot && snapshot.paused);
  $('btn-start').disabled = running; $('dash-start').disabled = running;
  $('btn-pause').disabled = !running || paused; $('btn-resume').disabled = !running || !paused; $('btn-stop').disabled = !running;
  const badge = $('dash-state');
  badge.textContent = running ? (paused ? 'PAUSED' : 'RUNNING') : 'IDLE';
  badge.className = 'badge' + (running ? (paused ? ' paused' : ' running') : '');
}
$('btn-start').onclick = start; $('dash-start').onclick = start;
$('btn-pause').onclick = () => api.control('pause');
$('btn-resume').onclick = () => api.control('resume');
$('btn-stop').onclick = () => { $('btn-stop').disabled = true; api.control('stop'); };
$('btn-show').onclick = () => api.browser(true);
$('btn-hide').onclick = () => api.browser(false);

function renderSnapshot(s, ev) {
  snapshot = s;
  $('run-state').textContent = s.paused ? 'PAUSED' : label(s.state).toUpperCase();
  $('run-phase').textContent = s.phaseText || '';
  const j = s.job || {};
  $('cur-job').textContent = j.title ? `${j.title}${j.company ? ' — ' + j.company : ''}` : '—';
  $('cur-jobid').textContent = j.id || '—';
  $('cur-search').textContent = s.search || '—';
  $('cur-page').textContent = s.page || '—';
  // a DRY run's counter is simulated pacing, never an application — say so
  const runText = `${s.counts.run} / ${s.counts.target}${s.mode === 'DRY' ? ' (dry run — simulated, nothing submitted)' : ''}`;
  $('cur-run').textContent = runText;
  $('cur-today').textContent = `${s.counts.today} / ${s.counts.dailyCap}`;
  const t = s.tallies;
  $('tallies').textContent = `Applied ${t.applied} · Already applied ${t.alreadyApplied} · Skipped ${t.skipped} · Failed ${t.failed} · Deferred ${t.deferred}` + (t.wouldApply ? ` · Would apply (dry) ${t.wouldApply}` : '');
  const m = s.match;
  $('cur-match').textContent = !m ? '—' : m.score == null ? 'unknown — add skills to your profile in Setup'
    : `${m.score}% ${m.decision} (${m.source})${m.belowThreshold ? ' · below your threshold — advisory only' : ''}` +
      ` · matched: ${(m.matchedSkills || []).join(', ') || '—'} · missing: ${(m.missingSkills || []).join(', ') || '—'}`;
  $('cur-question').textContent = s.question ? s.question.question : '—';
  $('cur-answer').textContent = s.question ? (s.question.answer ?? '(generating…)') : '—';
  const last = s.lastResult ? `${label(s.lastResult.state)} — ${(s.lastResult.job && s.lastResult.job.title) || ''} ${(s.lastResult.job && s.lastResult.job.company) ? '· ' + s.lastResult.job.company : ''}${s.lastResult.reason ? ' (' + s.lastResult.reason + ')' : ''}` : '—';
  $('cur-last').textContent = last; $('dash-last').textContent = last;
  $('dash-phase').textContent = `${label(s.state)}${s.phaseText ? ' — ' + s.phaseText : ''}`;
  $('dash-run').textContent = s.mode === 'DRY' ? `${s.counts.run} / ${s.counts.target} (dry)` : `${s.counts.run} / ${s.counts.target}`;
  $('dash-today').textContent = `${s.counts.today} / ${s.counts.dailyCap}`;
  $('dash-applied').textContent = t.applied; $('dash-already').textContent = t.alreadyApplied;
  $('dash-skipped').textContent = t.skipped; $('dash-failed').textContent = t.failed; $('dash-deferred').textContent = t.deferred;
  if (ev) {
    const list = $('event-list');
    list.prepend(el('li', {}, el('span', { class: 't', text: new Date(ev.ts).toLocaleTimeString() }), label(ev.state),
      ev.text ? ` — ${ev.text}` : '', ev.jobId ? ` [${ev.jobId}]` : ''));
    while (list.children.length > 200) list.lastChild.remove();
  }
  setControls();
}
api.onEvent((m) => {
  renderSnapshot(m.snapshot, m.event);
  if (['generating-answer', 'ai-matching', 'application-verified', 'skipped', 'failed', 'stopped', 'completed'].includes(m.event.state)) api.dashboard().then(renderAi);
});
api.onLog((line) => {
  const log = $('log');
  log.textContent += line + '\n';
  if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-50000);
  log.scrollTop = log.scrollHeight;
});
api.onExit(({ code }) => {
  running = false; runMode = null;
  $('log').textContent += `■ runner exited (code ${code})\n`;
  syncMode(); setControls(); refreshDashboard();
});

function renderAi(d) {
  const a = d.aiToday || {};
  $('dash-ai').textContent = `Gemini ${a.gemini || 0} · Groq ${a.groq || 0}`;
  const s = d.aiStatus || {};
  const notes = Object.entries(s).map(([n, x]) => !x.configured ? `${n}: not configured` : x.dailyUntil ? `${n}: daily limit until ${new Date(x.dailyUntil).toLocaleTimeString()}` : `${n}: ${x.model}`);
  $('dash-ai-note').textContent = [a.failed ? `${a.failed} failed` : '', ...notes].filter(Boolean).join(' · ');
}
async function refreshDashboard() {
  const d = await api.dashboard();
  renderAi(d);
  running = d.running;
  if (d.snapshot) renderSnapshot(d.snapshot);
  else { $('dash-today').textContent = `${d.today} / ${d.dailyCap}`; $('cur-today').textContent = `${d.today} / ${d.dailyCap}`; $('dash-run').textContent = `0 / ${d.perRun}`; }
  setControls();
}

// ---------------------------------------------------------------- applications
let appRows = [];
let appFilter = 'ALL';
document.querySelectorAll('#app-chips .chip').forEach((c) => c.addEventListener('click', () => {
  appFilter = c.dataset.f;
  document.querySelectorAll('#app-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
  renderApplications();
}));
['f-from', 'f-to', 'f-company', 'f-title', 'f-platform'].forEach((id) => $(id).addEventListener('input', renderApplications));
$('apps-refresh').onclick = loadApplications;
async function loadApplications() { appRows = await api.applications(); renderApplications(); }
function renderApplications() {
  const today = new Date(); const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const from = $('f-from').value, to = $('f-to').value;
  const co = $('f-company').value.trim().toLowerCase(), ti = $('f-title').value.trim().toLowerCase();
  const rows = appRows.filter((r) =>
    (appFilter === 'ALL' || (appFilter === 'TODAY' ? r.day === todayKey : r.category === appFilter)) &&
    (!from || r.day >= from) && (!to || r.day <= to) &&
    (!co || r.company.toLowerCase().includes(co)) && (!ti || r.title.toLowerCase().includes(ti)));
  const body = $('apps-body'); body.textContent = '';
  for (const r of rows) {
    body.append(el('tr', { onclick: () => openJob(r.jobId) },
      el('td', { text: fmtTime(r.ts) }), el('td', { text: r.title || r.jobId }), el('td', { text: r.company }),
      el('td', { text: r.location }), el('td', {}, el('span', { class: `pill ${r.category}`, text: CAT[r.category] || r.category })),
      el('td', { text: r.reason }), el('td', { text: r.match == null ? '' : `${r.match}%` }), el('td', { text: r.platform })));
  }
  $('apps-empty').classList.toggle('hidden', rows.length > 0);
}

// ---------------------------------------------------------------- job details
$('job-back').onclick = () => show('applications');
async function openJob(id) {
  const j = await api.job(id);
  const d = j.details || {};
  $('job-title').textContent = `${d.title || (j.ledger[0] && j.ledger[0].title) || 'Job'} ${d.company ? '· ' + d.company : ''}`;
  const root = $('job-root'); root.textContent = '';
  const info = el('table', { class: 'kvtable' });
  const row = (k, v) => { if (v) info.append(el('tr', {}, el('td', { text: k }), el('td', { text: v }))); };
  row('Job ID', j.jobId); row('Status', CAT[j.category] || j.category || '—'); row('Location', d.location); row('Salary', d.salary);
  row('Experience', d.experience); row('Posted / applicants', d.stats); row('Tags', (d.tags || []).join(', '));
  row('Search', d.search); row('Results page', d.page); row('URL', (j.ledger[0] && j.ledger[0].url) || d.url);
  root.append(el('div', { class: 'panel' }, info));
  if (d.match) {
    root.append(el('h3', { class: 'section-title', text: `AI match (advisory): ${d.match.score}% — ${d.match.decision}` }),
      el('div', { class: 'panel' }, el('div', { text: `Matched: ${(d.match.matchedSkills || []).join(', ') || '—'}` }),
        el('div', { text: `Missing: ${(d.match.missingSkills || []).join(', ') || '—'}` }),
        el('ul', {}, (d.match.reasons || []).map((x) => el('li', { text: x })))));
  }
  root.append(el('h3', { class: 'section-title', text: 'Ledger (authoritative)' }),
    el('ul', { class: 'timeline' }, j.ledger.map((r) => el('li', { text: `${fmtTime(r.ts)} — ${r.status} — ${r.reason}` }))),
    j.deferred.length ? el('p', { class: 'muted', text: `Deferred company-site job since ${fmtTime(j.deferred[0].ts)}` }) : null);
  for (const h of j.history) {
    const o = h.outcome || {};
    const box = el('div', { class: 'panel' },
      el('div', { class: 'k', text: `Run ${h.runId} · ${h.mode} · ${o.status || ''} ${o.reason ? '— ' + o.reason : ''}` }),
      el('ul', { class: 'timeline' }, (h.timeline || []).map((t) => el('li', { text: `${new Date(t.ts).toLocaleTimeString()} — ${label(t.state)}${t.text ? ' — ' + t.text : ''}` }))));
    for (const q of h.questions || []) {
      const res = q.result || {};
      box.append(el('div', { class: 'qa' }, el('div', {}, el('b', { text: 'Q: ' }), q.question),
        q.options && q.options.length ? el('div', { class: 'muted', text: `Options: ${q.options.join(' | ')}` }) : null,
        res.status === 'answered' ? el('div', {}, el('b', { text: 'A: ' }), res.answer, el('span', { class: 'muted', text: `  (${res.source}: ${res.evidence})` }))
          : el('div', { class: 'red', text: `Unknown — ${res.category}: ${res.missing || ''}` })));
    }
    if (o.intervention) {
      const iv = o.intervention;
      box.append(el('div', { class: 'qa' }, el('b', { text: 'Human intervention required' }),
        el('div', { text: `Category: ${iv.category}` }), el('div', { text: `Stage: ${iv.stage || ''}` }),
        iv.question ? el('div', { text: `Question: ${iv.question}` }) : null,
        iv.options && iv.options.length ? el('div', { text: `Options: ${iv.options.join(' | ')}` }) : null,
        iv.missing ? el('div', { text: `Missing: ${iv.missing}` }) : null,
        o.pageStateAfterAbandon ? el('div', { class: 'muted', text: `After abandoning, the job page read: ${o.pageStateAfterAbandon}` }) : null));
    }
    if (o.verification) box.append(el('div', { class: 'muted', text: `Verification (reload): ${o.verification}` }));
    root.append(box);
  }
  if (d.description) root.append(el('h3', { class: 'section-title', text: 'Description (captured)' }), el('div', { class: 'panel', text: d.description }));
  show('job');
}

// ---------------------------------------------------------------- reports
$('reports-refresh').onclick = loadReports;
async function loadReports() {
  const r = await api.reports();
  const root = $('reports-root'); root.textContent = '';
  const table = (heads, rows) => el('table', { class: 'table' }, el('thead', {}, el('tr', {}, heads.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', { text: String(c) }))))));
  root.append(el('h3', { class: 'section-title', text: 'Outcomes (latest status per job)' }),
    table(Object.keys(r.outcomes).map((k) => CAT[k] || k), [Object.values(r.outcomes)]));
  root.append(el('h3', { class: 'section-title', text: 'Daily activity' }),
    table(['Day', 'Applied (new, verified)', 'Already applied', 'Skipped', 'Failed', 'Deferred'], r.daily.map((d) => [d.day, d.APPLIED, d.ALREADY_APPLIED, d.SKIPPED, d.FAILED, d.DEFERRED])));
  const ints = Object.entries(r.interventions).sort((a, b) => b[1] - a[1]);
  root.append(el('h3', { class: 'section-title', text: 'Human-intervention categories (what blocks automation)' }),
    ints.length ? table(['Category', 'Jobs'], ints) : el('p', { class: 'muted', text: 'None recorded yet.' }));
  const fails = Object.entries(r.failures).sort((a, b) => b[1] - a[1]);
  root.append(el('h3', { class: 'section-title', text: 'Failure reasons' }),
    fails.length ? table(['Reason', 'Count'], fails) : el('p', { class: 'muted', text: 'None recorded.' }));
  root.append(el('h3', { class: 'section-title', text: 'AI matching (advisory)' }),
    el('p', { text: r.matching.jobs ? `${r.matching.jobs} jobs scored, average ${r.matching.avgScore}%` : 'No jobs scored yet.' }));
  root.append(el('h3', { class: 'section-title', text: 'Runs' }),
    table(['Run', 'Mode', 'Started', 'Jobs', 'Outcomes'], r.runs.map((x) => [x.runId, x.mode, fmtTime(x.first), x.jobs,
      Object.entries(x.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')])));
}

// ---------------------------------------------------------------- Settings > Advanced (both default Off)
async function loadAdvanced() {
  const d = await api.setup.load();
  const m = (d.prefs && d.prefs.matching) || { aiEnabled: false, thresholdEnabled: false, threshold: 60 };
  $('adv-aimatch').checked = !!m.aiEnabled;
  $('adv-thr-on').checked = !!m.thresholdEnabled;
  $('adv-thr').value = m.threshold;
  $('adv-status').textContent = '';
}
$('adv-save').onclick = async () => {
  const r = await api.setup.savePrefs({ matching: { aiEnabled: $('adv-aimatch').checked, thresholdEnabled: $('adv-thr-on').checked, threshold: $('adv-thr').value } });
  const m = r.prefs.matching;
  $('adv-status').textContent = `Saved — AI matching ${m.aiEnabled ? 'on' : 'off'}, threshold ${m.thresholdEnabled ? m.threshold + '%' : 'off'}.`;
};

syncMode();
refreshDashboard();
if (window.ApplyItInbox) window.ApplyItInbox.load();
