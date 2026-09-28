/* ApplyIt Setup — 3 required steps (resume, job titles, locations), everything else optional.
   Data is inserted with textContent only. */
'use strict';
(() => {
  const S = window.applyit.setup;
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const csv = (v) => String(v || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const cells = (line, n) => { const c = line.split('|').map((s) => s.trim()); while (c.length < n) c.push(''); return c; };
  const row = (label, input) => h('div', { class: 'form-row' }, h('label', { text: label }), input);
  const text = (id, value = '', ph = '') => h('input', { id, value: value == null ? '' : String(value), placeholder: ph });
  const area = (id, value = '', ph = '', rows = 3) => { const a = h('textarea', { id, placeholder: ph, rows: String(rows) }); a.value = value; return a; };
  const chk = (id, label, on) => h('label', { class: 'check inline' }, (() => { const c = h('input', { type: 'checkbox', id }); c.checked = !!on; return c; })(), ' ' + label);

  let data = null;   // setup:load result
  let draft = null;  // profile being shown / edited (keeps resumeText, resumeFile)
  let dirtyProfile = false;

  // ---------------------------------------------------------------- step 1: resume summary
  function summary(p) {
    if (!p || (!p.name && !(p.skills || []).length && !(p.jobs || []).length)) {
      return h('p', { class: 'muted', text: 'No resume yet — choose your resume PDF above.' });
    }
    const current = (p.jobs || []).find((j) => /present|current|now|till date/i.test(j.end || '')) || (p.jobs || [])[0];
    const skills = [...(p.skills || []), ...(p.tools || [])];
    return h('div', { class: 'summary' },
      h('div', { class: 'summary-name', text: p.name || '(name not found)' }),
      h('div', { class: 'muted', text: [p.email, p.phone, p.location].filter(Boolean).join(' · ') || 'no contact details found' }),
      current ? h('div', {}, h('b', { text: 'Now: ' }), `${current.title || ''}${current.employer ? ' at ' + current.employer : ''}`) : null,
      (p.jobs || []).length ? h('div', { class: 'muted', text: `Experience: ${(p.jobs || []).slice(0, 4).map((j) => `${j.title || ''}${j.employer ? ' @ ' + j.employer : ''}${j.start ? ` (${j.start}–${j.end || ''})` : ''}`).join(' · ')}` }) : null,
      (p.education || []).length ? h('div', { class: 'muted', text: `Education: ${p.education.map((e) => [e.degree, e.institution, e.year].filter(Boolean).join(', ')).join(' · ')}` }) : null,
      skills.length ? h('div', { class: 'chips-ro' }, skills.slice(0, 18).map((s) => h('span', { class: 'chip-ro', text: s })),
        skills.length > 18 ? h('span', { class: 'muted', text: ` +${skills.length - 18} more` }) : null) : null,
      (p.certifications || []).length ? h('div', { class: 'muted', text: `Certifications: ${p.certifications.join(' · ')}` }) : null);
  }
  function editForm(p) {
    return h('div', { id: 'edit-form', class: 'panel inner' },
      row('Name', text('p-name', p.name)), row('Email', text('p-email', p.email)), row('Phone', text('p-phone', p.phone)),
      row('Location', text('p-location', p.location)), row('Headline', text('p-headline', p.headline)),
      row('Skills', area('p-skills', (p.skills || []).join(', '), 'comma separated')),
      row('Tools / software', area('p-tools', (p.tools || []).join(', '), 'comma separated', 2)),
      row('Languages', text('p-languages', (p.languages || []).join(', '))),
      row('Jobs', area('p-jobs', (p.jobs || []).map((j) => [j.title, j.employer, j.start, j.end].join(' | ')).join('\n'), 'Title | Employer | Start | End  (one per line)', 4)),
      row('Education', area('p-education', (p.education || []).map((e) => [e.degree, e.institution, e.year].join(' | ')).join('\n'), 'Degree | Institution | Year', 2)),
      row('Certifications', area('p-certs', (p.certifications || []).join('\n'), 'one per line', 2)),
      row('Projects', area('p-projects', (p.projects || []).map((x) => [x.name, x.description].join(' | ')).join('\n'), 'Name | Description', 2)),
      h('button', { text: 'Done', onclick: () => { draft = readEdit(); dirtyProfile = true; renderResume(); } }));
  }
  function readEdit() {
    return {
      ...(draft || {}),
      name: $('p-name').value, email: $('p-email').value, phone: $('p-phone').value, location: $('p-location').value, headline: $('p-headline').value,
      skills: csv($('p-skills').value), tools: csv($('p-tools').value), languages: csv($('p-languages').value),
      jobs: lines($('p-jobs').value).map((l) => { const [title, employer, start, end] = cells(l, 4); return { title, employer, start, end }; }),
      education: lines($('p-education').value).map((l) => { const [degree, institution, year] = cells(l, 3); return { degree, institution, year }; }),
      certifications: lines($('p-certs').value),
      projects: lines($('p-projects').value).map((l) => { const [name, ...d] = l.split('|'); return { name: name.trim(), description: d.join('|').trim() }; }),
    };
  }
  function renderResume(dropped = null) {
    const box = $('resume-box');
    box.textContent = '';
    box.append(summary(draft));
    if (dropped && dropped.length) {
      box.append(h('details', { class: 'dropped' }, h('summary', { text: `${dropped.length} value(s) removed because they are not written in your resume` }),
        h('ul', {}, dropped.map((x) => h('li', { text: x })))));
    }
    box.append(h('button', { class: 'link', id: 'edit-btn', text: draft ? 'Edit details' : 'Enter details by hand',
      onclick: () => { if (!$('edit-form')) box.append(editForm(draft || {})); } }));
  }
  async function chooseResume() {
    const f = await S.pickResume(); if (!f) return;
    $('r-status').textContent = 'Reading your resume…';
    const r = await S.extract(f);
    if (!r.ok) { $('r-status').textContent = `Could not read it: ${r.error}`; return; }
    draft = { ...r.profile, userProvided: (data.profile && data.profile.userProvided) || {} };
    dirtyProfile = true;
    $('r-status').textContent = `Read (${r.ai}). Check the summary, confirm steps 2 and 3, then Save.`;
    renderResume(r.dropped);
    // re-suggest from the new resume unless the user already typed something
    const sug = suggestFrom(draft);
    if (!$('s-titles').dataset.touched) $('s-titles').value = sug.titles.join('\n');
    if (!$('s-keywords').dataset.touched) $('s-keywords').value = sug.keywords.join(', ');
    if (!$('s-locs').dataset.touched) $('s-locs').value = sug.locations.join('\n');
    preview();
  }
  // same rule as resume-profile.js suggestPreferences(), for a freshly extracted draft
  function suggestFrom(p) {
    const cur = (j) => /present|current|now|till date/i.test(j.end || '');
    const jobs = [...(p.jobs || [])].sort((a, b) => Number(cur(b)) - Number(cur(a)));
    const titles = [...new Map(jobs.filter((j) => j.title).map((j) => [j.title.toLowerCase(), j.title])).values()].slice(0, 3);
    const loc = String((p.userProvided && p.userProvided.currentLocation) || p.location || '').split(',')[0].trim();
    return { titles, keywords: [...new Set(p.skills || [])].slice(0, 5), locations: loc ? [loc] : [] };
  }

  // ---------------------------------------------------------------- optional details
  let sourcesByKey = {};
  function hint(key) {
    const s = sourcesByKey[key];
    if (!s) return '';
    if (s.source === 'setup') return 'saved';
    if (s.source === 'resume') return `empty → from your resume: ${s.value}`;
    if (s.source === 'env') return `empty → from .env: ${s.value}`;
    return 'not set — job questions about this go to your "Needs your answer" inbox';
  }
  function moreDetails(p, prefs, max) {
    const u = (p && p.userProvided) || {};
    const modes = prefs.workModes || [];
    const rel = h('select', { id: 's-reloc' }, ['unspecified', 'yes', 'no'].map((v) => { const o = h('option', { value: v, text: v }); if (v === prefs.relocation) o.selected = true; return o; }));
    return h('details', { id: 'more', class: 'more' }, h('summary', { text: 'More details (optional)' }),
      h('p', { class: 'note', text: 'Only needed when job questions ask for them — anything unanswered comes to your "Needs your answer" inbox instead. Empty fields fall back to .env.' }),
      data.appFacts.map((f) => row(f.label, h('div', {}, text(`u-${f.key}`, u[f.key] || ''), h('div', { class: 'note', 'data-hint': f.key, text: hint(f.key) })))),
      row('Total experience (years)', text('u-totalExperienceYears', u.totalExperienceYears, 'e.g. 3')),
      row('Also OK', h('div', {}, chk('s-hybrid', 'Hybrid', modes.includes('hybrid')), chk('s-onsite', 'On-site', modes.includes('on-site')))),
      row('Willing to relocate', rel),
      row('Salary range (lakhs/yr)', h('div', { class: 'pair' }, text('s-salmin', prefs.salary && prefs.salary.min, 'min'), text('s-salmax', prefs.salary && prefs.salary.max, 'max'))),
      row('Experience range (years)', h('div', { class: 'pair' }, text('s-expmin', prefs.experience && prefs.experience.min, 'min (also used in searches)'), text('s-expmax', prefs.experience && prefs.experience.max, 'max'))),
      row('Title must NOT include', area('s-excl', (prefs.excludeKeywords || []).join('\n'), 'one per line (added to the built-in blocklist)', 2)),
      row(`Max per run (≤ ${max.perRun})`, text('s-perrun', (prefs.limits && prefs.limits.perRun) || max.perRun)),
      row(`Max per day (≤ ${max.daily})`, text('s-daily', (prefs.limits && prefs.limits.daily) || max.daily)));
  }

  // ---------------------------------------------------------------- save
  function readPrefs() {
    const modes = [$('s-remote').checked && 'remote', $('s-hybrid').checked && 'hybrid', $('s-onsite').checked && 'on-site'].filter(Boolean);
    return {
      titles: lines($('s-titles').value), includeKeywords: csv($('s-keywords').value),
      locations: $('s-any').checked ? [] : lines($('s-locs').value), anyLocation: $('s-any').checked, workModes: modes,
      relocation: $('s-reloc').value,
      salary: { min: $('s-salmin').value, max: $('s-salmax').value }, experience: { min: $('s-expmin').value, max: $('s-expmax').value },
      excludeKeywords: lines($('s-excl').value), limits: { perRun: $('s-perrun').value, daily: $('s-daily').value },
    };
  }
  function readUserProvided() {
    return { ...Object.fromEntries(data.appFacts.map((f) => [f.key, $(`u-${f.key}`).value])), totalExperienceYears: $('u-totalExperienceYears').value };
  }
  async function save() {
    if ($('edit-form')) { draft = readEdit(); dirtyProfile = true; }
    const prefs = readPrefs();
    if (!prefs.titles.length) { $('save-status').textContent = 'Add at least one job title to search for (step 2).'; return; }
    if (!prefs.anyLocation && !prefs.locations.length) { $('save-status').textContent = 'Add a location, or tick "Any location" (step 3).'; return; }
    const up = readUserProvided();
    const upChanged = Object.entries(up).some(([k, v]) => String(v || '') !== String(((data.profile || {}).userProvided || {})[k] || ''));
    if (dirtyProfile || upChanged) await S.saveProfile({ ...(draft || {}), userProvided: up });
    const r = await S.savePrefs(prefs);
    dirtyProfile = false;
    $('save-status').textContent = `Saved — ${r.searches.length} Naukri search${r.searches.length === 1 ? '' : 'es'}, limits ${r.prefs.limits.perRun}/run · ${r.prefs.limits.daily}/day.`;
    refreshHints();
  }
  async function preview() {
    const urls = await S.previewSearches({ titles: lines($('s-titles').value), experience: { min: $('s-expmin') ? $('s-expmin').value : '' } });
    const ul = $('s-searches'); ul.textContent = '';
    for (const u of urls) ul.append(h('li', { text: u }));
    if (!urls.length) ul.append(h('li', { class: 'muted', text: 'Add a job title to create a search.' }));
  }
  async function refreshHints() {
    data = await S.load();
    sourcesByKey = Object.fromEntries(data.factSources.map((s) => [s.key, s]));
    document.querySelectorAll('[data-hint]').forEach((n) => { n.textContent = hint(n.dataset.hint); });
  }

  async function load() {
    data = await S.load();
    sourcesByKey = Object.fromEntries(data.factSources.map((s) => [s.key, s]));
    draft = data.profile || null;
    dirtyProfile = false;
    const prefs = data.prefs || { limits: {} };
    const sug = data.suggestions || { titles: [], keywords: [], locations: [] };
    const has = (a) => Array.isArray(a) && a.length;
    const root = $('setup-root');
    root.textContent = '';
    root.append(
      h('p', { class: 'muted', text: 'Three steps, about two minutes: your resume, the jobs to look for, and where.' }),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '1' }), h('div', { class: 'step-body' },
        h('h3', { text: 'Your resume' }),
        h('div', {}, h('button', { class: 'primary', text: draft ? 'Replace resume PDF…' : 'Choose resume PDF…', onclick: chooseResume }),
          h('span', { id: 'r-status', class: 'muted', style: 'margin-left:10px', text: data.hasKey ? `Read by AI (${data.model}); only what is written in your resume is kept.` : 'No AI key: the text is read and email/phone found — use "Enter details by hand" for the rest.' })),
        h('div', { id: 'resume-box' }))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '2' }), h('div', { class: 'step-body' },
        h('h3', { text: 'Jobs to look for' }),
        h('p', { class: 'note', text: has(prefs.titles) ? 'Your saved titles.' : sug.titles.length ? 'Suggested from your resume — confirm or edit.' : 'One job title per line.' }),
        area('s-titles', (has(prefs.titles) ? prefs.titles : sug.titles).join('\n'), 'e.g. Data Analyst', 3),
        h('div', { class: 'k', style: 'margin-top:8px', text: 'Keywords (optional) — a job title may contain one of these instead' }),
        text('s-keywords', (has(prefs.includeKeywords) ? prefs.includeKeywords : sug.keywords).join(', '), 'e.g. Power BI, SQL'),
        h('div', { class: 'k', style: 'margin-top:8px', text: 'Naukri searches' }), h('ul', { id: 's-searches', class: 'timeline' }))),
      h('div', { class: 'step' }, h('div', { class: 'step-n', text: '3' }), h('div', { class: 'step-body' },
        h('h3', { text: 'Where' }),
        area('s-locs', (has(prefs.locations) ? prefs.locations : sug.locations).join('\n'), 'one city per line, e.g. Pune', 2),
        h('div', {}, chk('s-any', 'Any location', prefs.savedAt && prefs.anyLocation && !has(prefs.locations)), chk('s-remote', 'Remote is fine', (prefs.workModes || []).includes('remote'))))),
      moreDetails(draft, prefs, data.max),
      h('div', { class: 'save-bar' }, h('button', { class: 'primary big', id: 'setup-save', text: 'Save', onclick: save }), h('span', { id: 'save-status', class: 'muted' })));
    renderResume();
    for (const id of ['s-titles', 's-keywords', 's-locs']) $(id).addEventListener('input', () => { $(id).dataset.touched = '1'; if (id === 's-titles') preview(); });
    $('s-expmin').addEventListener('input', preview);
    preview();
  }
  window.ApplyItSetup = { load };
})();
