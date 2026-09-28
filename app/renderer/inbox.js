/* "Needs your answer" inbox on the Dashboard. textContent only. */
'use strict';
(() => {
  const I = window.applyit.inbox;
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };

  function jobsLine(g) {
    const names = g.jobs.slice(0, 3).map((j) => [j.title, j.company].filter(Boolean).join(' — ') || j.jobId);
    return `Asked by ${g.jobs.length} job${g.jobs.length === 1 ? '' : 's'}: ${names.join(' · ')}${g.jobs.length > 3 ? ` +${g.jobs.length - 3} more` : ''}`;
  }

  function item(g) {
    const err = h('div', { class: 'q-error' });
    const act = async (p) => { const r = await p; if (!r.ok) { err.textContent = r.error; return; } render(r); };
    const actions = h('div', { class: 'q-actions' });
    if (g.options && g.options.length) {
      // option questions: the original options as buttons — the answer is always one of them, verbatim
      for (const o of g.options) actions.append(h('button', { class: 'opt', text: o, onclick: () => act(I.answer(g.key, o)) }));
    } else {
      const input = h('input', { placeholder: 'Your answer (used for every future job asking this)' });
      actions.append(input, h('button', { class: 'primary', text: 'Save answer', onclick: () => act(I.answer(g.key, input.value)) }));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') act(I.answer(g.key, input.value)); });
    }
    actions.append(h('button', { class: 'link', text: "Don't answer this", title: 'Jobs asking this keep being skipped', onclick: () => act(I.dont(g.key)) }));
    return h('div', { class: 'q-item', 'data-key': g.key },
      h('div', { class: 'q-text', text: g.question }),
      h('div', { class: 'q-meta', text: jobsLine(g) + (g.missing.length ? ` · needed: ${g.missing[0]}` : '') }),
      actions, err);
  }

  function render(v) {
    const n = v.open.length;
    const count = $('inbox-count');
    count.textContent = n;
    count.className = 'badge-count' + (n ? '' : ' zero');
    const nav = $('nav-inbox');
    nav.textContent = n;
    nav.classList.toggle('hidden', !n);
    const list = $('inbox-list');
    list.textContent = '';
    if (!n) list.append(h('p', { class: 'muted', text: 'Nothing waiting. Questions ApplyIt can\'t answer truthfully will appear here.' }));
    for (const g of v.open) list.append(item(g));
    const done = [...v.answered.map((a) => ({ ...a, kind: 'answer' })), ...v.declined.map((d) => ({ ...d, kind: 'dont' }))];
    $('inbox-done').classList.toggle('hidden', !done.length);
    $('inbox-done-sum').textContent = `Your saved answers (${v.answered.length}) and skipped questions (${v.declined.length})`;
    const dl = $('inbox-done-list');
    dl.textContent = '';
    for (const d of done) {
      dl.append(h('div', { class: 'q-item' }, h('div', { class: 'q-text', text: d.question }),
        h('div', { class: 'q-meta', text: d.kind === 'answer' ? `Answered by you: ${d.answer}` : "Not answered — jobs asking this are skipped" }),
        h('button', { class: 'link', text: 'Forget', onclick: async () => render(await I.forget(d.key)) })));
    }
  }

  async function load() { render(await I.list()); }
  window.ApplyItInbox = { load, render };
})();
