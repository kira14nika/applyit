/* ApplyIt Setup page: resume → reviewed profile, and preferences. textContent only. */
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
  let draft = null; // profile being edited (kept for resumeText / resumeFile)

  const row = (label, input) => h('div', { class: 'form-row' }, h('label', { text: label }), input);
  const text = (id, value = '', ph = '') => h('input', { id, value, placeholder: ph });
  const area = (id, value = '', ph = '', rows = 3) => { const a = h('textarea', { id, placeholder: ph, rows: String(rows) }); a.value = value; return a; };

  function profileForm(p) {
    const u = p.userProvided || {};
    return h('div', {},
      row('Name', text('p-name', p.name)), row('Email', text('p-email', p.email)), row('Phone', text('p-phone', p.phone)),
      row('Location', text('p-location', p.location)), row('Headline', text('p-headline', p.headline)),
      row('Skills', area('p-skills', (p.skills || []).join(', '), 'comma separated')),
      row('Tools / software', area('p-tools', (p.tools || []).join(', '), 'comma separated')),
      row('Languages', text('p-languages', (p.languages || []).join(', '))),
      row('Jobs', area('p-jobs', (p.jobs || []).map((j) => [j.title, j.employer, j.start, j.end].join(' | ')).join('\n'), 'Title | Employer | Start | End  (one per line)', 4)),
      row('Education', area('p-education', (p.education || []).map((e) => [e.degree, e.institution, e.year].join(' | ')).join('\n'), 'Degree | Institution | Year', 3)),
      row('Certifications', area('p-certs', (p.certifications || []).join('\n'), 'one per line')),
      row('Projects', area('p-projects', (p.projects || []).map((x) => [x.name, x.description].join(' | ')).join('\n'), 'Name | Description', 3)),
      h('h3', { class: 'section-title', text: 'What a resume usually doesn\'t say (used to answer questions)' }),
      row('Notice period', text('u-notice', u.noticePeriod, 'e.g. 30 days')),
      row('Current CTC (lakhs/yr)', text('u-cctc', u.currentCTC, 'e.g. 6')),
      row('Expected CTC (lakhs/yr)', text('u-ectc', u.expectedCTC, 'e.g. 8')),
      row('Total experience (years)', text('u-exp', u.totalExperienceYears, 'e.g. 3')),
      row('Work authorization', text('u-auth', u.workAuthorization, 'e.g. Indian citizen')),
      h('button', { class: 'primary', text: 'Save profile', onclick: saveProfile }), h('span', { id: 'p-status', class: 'muted', style: 'margin-left:10px' }));
  }

  function readProfile() {
    return {
      ...(draft || {}),
      name: $('p-name').value, email: $('p-email').value, phone: $('p-phone').value, location: $('p-location').value, headline: $('p-headline').value,
      skills: csv($('p-skills').value), tools: csv($('p-tools').value), languages: csv($('p-languages').value),
      jobs: lines($('p-jobs').value).map((l) => { const [title, employer, start, end] = cells(l, 4); return { title, employer, start, end }; }),
      education: lines($('p-education').value).map((l) => { const [degree, institution, year] = cells(l, 3); return { degree, institution, year }; }),
      certifications: lines($('p-certs').value),
      projects: lines($('p-projects').value).map((l) => { const [name, ...d] = l.split('|'); return { name: name.trim(), description: d.join('|').trim() }; }),
      userProvided: { noticePeriod: $('u-notice').value, currentCTC: $('u-cctc').value, expectedCTC: $('u-ectc').value,
        totalExperienceYears: $('u-exp').value, workAuthorization: $('u-auth').value },
    };
  }
  async function saveProfile() {
    const r = await S.saveProfile(readProfile());
    draft = r.profile;
    $('p-status').textContent = r.ok ? `Saved ${new Date(r.profile.savedAt).toLocaleTimeString()} — answers now come from this profile.` : 'Save failed';
  }

  function prefsForm(p, max) {
    const modes = p.workModes || [];
    const chk = (id, label, on) => h('label', { class: 'check', style: 'display:inline-block;margin-right:14px' }, (() => { const c = h('input', { type: 'checkbox', id }); c.checked = !!on; return c; })(), ' ' + label);
    const rel = h('select', { id: 's-reloc' }, ['unspecified', 'yes', 'no'].map((v) => { const o = h('option', { value: v, text: v }); if (v === p.relocation) o.selected = true; return o; }));
    return h('div', {},
      row('Job titles / search keywords', area('s-titles', (p.titles || []).join('\n'), 'one per line, e.g. Data Analyst', 3)),
      row('Preferred locations', area('s-locs', (p.locations || []).join('\n'), 'one per line; leave empty for any location', 2)),
      row('Work mode', h('div', {}, chk('s-remote', 'Remote', modes.includes('remote')), chk('s-hybrid', 'Hybrid', modes.includes('hybrid')), chk('s-onsite', 'On-site', modes.includes('on-site')))),
      row('Willing to relocate', rel),
      row('Salary range (lakhs/yr)', h('div', {}, text('s-salmin', p.salary?.min ?? '', 'min'), text('s-salmax', p.salary?.max ?? '', 'max'))),
      row('Experience range (years)', h('div', {}, text('s-expmin', p.experience?.min ?? '', 'min — also used as ?experience= in searches'), text('s-expmax', p.experience?.max ?? '', 'max'))),
      row('Title must include (any)', area('s-incl', (p.includeKeywords || []).join('\n'), 'extra title words, one per line', 2)),
      row('Title must NOT include', area('s-excl', (p.excludeKeywords || []).join('\n'), 'one per line (added to the built-in blocklist)', 2)),
      row(`Max per run (≤ ${max.perRun})`, text('s-perrun', p.limits?.perRun ?? max.perRun)),
      row(`Max per day (≤ ${max.daily})`, text('s-daily', p.limits?.daily ?? max.daily)),
      h('div', { class: 'k', style: 'margin-top:10px', text: 'Naukri searches that will be used' }), h('ul', { id: 's-searches', class: 'timeline' }),
      h('button', { class: 'primary', text: 'Save preferences', onclick: savePrefs }), h('span', { id: 's-status', class: 'muted', style: 'margin-left:10px' }));
  }
  function readPrefs() {
    return {
      titles: lines($('s-titles').value), locations: lines($('s-locs').value),
      workModes: [['s-remote', 'remote'], ['s-hybrid', 'hybrid'], ['s-onsite', 'on-site']].filter(([id]) => $(id).checked).map(([, m]) => m),
      relocation: $('s-reloc').value,
      salary: { min: $('s-salmin').value, max: $('s-salmax').value }, experience: { min: $('s-expmin').value, max: $('s-expmax').value },
      includeKeywords: lines($('s-incl').value), excludeKeywords: lines($('s-excl').value),
      limits: { perRun: $('s-perrun').value, daily: $('s-daily').value },
    };
  }
  async function preview() {
    const urls = await S.previewSearches(readPrefs());
    const ul = $('s-searches'); ul.textContent = '';
    if (!urls.length) ul.append(h('li', { class: 'muted', text: 'No titles yet — the built-in searches are used.' }));
    for (const u of urls) ul.append(h('li', { text: u }));
  }
  async function savePrefs() {
    const r = await S.savePrefs(readPrefs());
    $('s-status').textContent = `Saved — limits ${r.prefs.limits.perRun}/run, ${r.prefs.limits.daily}/day; ${r.searches.length} searches.`;
    $('s-perrun').value = r.prefs.limits.perRun; $('s-daily').value = r.prefs.limits.daily;
    preview();
  }

  async function load() {
    const d = await S.load();
    draft = d.profile || { userProvided: {} };
    const root = $('setup-root'); root.textContent = '';
    const status = h('div', { id: 'r-status', class: 'muted' });
    const dropped = h('ul', { id: 'r-dropped', class: 'timeline' });
    root.append(
      h('h3', { class: 'section-title', text: '1 · Resume' }),
      h('p', { class: 'muted', text: d.hasKey ? `AI extraction uses ${d.model}. Only values found word-for-word in your resume are kept.` : 'GEMINI_KEY is not set in .env — the resume text is read, email/phone are found, and you fill in the rest.' }),
      h('button', { text: 'Choose resume PDF…', onclick: async () => {
        const f = await S.pickResume(); if (!f) return;
        status.textContent = `Reading ${f} …`; dropped.textContent = '';
        const r = await S.extract(f);
        if (!r.ok) { status.textContent = `Could not read it: ${r.error}`; return; }
        draft = { ...r.profile, userProvided: (d.profile && d.profile.userProvided) || {} };
        status.textContent = `Read ${r.profile.resumeText.length} characters. AI: ${r.ai}. Review below, then Save profile.`;
        for (const x of r.dropped) dropped.append(h('li', { text: `removed (not in resume): ${x}` }));
        $('profile-form').replaceWith(Object.assign(profileForm(draft), { id: 'profile-form' }));
      } }),
      status, dropped,
      h('h3', { class: 'section-title', text: '2 · Profile — review and edit' }),
      d.profile ? h('p', { class: 'muted', text: `Saved ${new Date(d.profile.savedAt).toLocaleString()}${d.profile.resumeFile ? ' from ' + d.profile.resumeFile : ''}` })
        : h('p', { class: 'muted', text: 'No profile yet — answers currently come from the .env file.' }),
      Object.assign(profileForm(draft), { id: 'profile-form' }),
      h('h3', { class: 'section-title', text: '3 · Job preferences' }),
      prefsForm(d.prefs || { limits: {} }, d.max));
    ['s-titles', 's-expmin'].forEach((id) => $(id).addEventListener('input', preview));
    preview();
  }
  window.ApplyItSetup = { load };
})();
