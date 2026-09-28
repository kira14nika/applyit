/**
 * Naukri Auto-Apply — personal data loaded from .env
 * =================================
 * HOW TO USE:
 * 1. Log in to naukri.com and open a job search, e.g.
 *    https://www.naukri.com/full-stack-developer-jobs?experience=1
 *    (any search works — the script filters titles itself).
 * 2. ALLOW POPUPS for naukri.com (the script opens each job in a popup window
 *    it controls — same origin, so one paste drives many applications).
 *    Chrome: click the blocked-popup icon in the address bar → Always allow.
 * 3. Open DevTools console (F12 → Console), paste this WHOLE file, press Enter.
 *    Keep BOTH the search tab and the popup visible; don't close the popup.
 * 4. It starts in DRY_RUN mode: it opens each matching job and finds the Apply
 *    button but does NOT click it. Watch a couple, then set DRY_RUN = false
 *    and re-paste to apply for real.
 *
 * WHAT IT DOES PER JOB:
 * - Skips "Apply on company site" (external) and already-applied jobs.
 * - Clicks Apply (one-click — Naukri sends your profile + resume).
 * - If Naukri's chatbot questionnaire pops up, each question is sent to the
 *   runner's answer engine (Node: the user's own facts, then Gemini). If no
 *   truthful answer exists the questionnaire is abandoned and the job SKIPPED.
 *   Pasted by hand (no runner) the script can never answer, and never clicks.
 *
 * NOTES:
 * - When the current results page is exhausted it clicks Next — that reloads
 *   the page and KILLS the script; PASTE AGAIN there. Progress is kept in
 *   localStorage so it continues where it left off.
 * - Naukri changes its HTML often; lookups are text-based to survive that, but
 *   if it stops finding things, update the SELECTORS section.
 * - Auto-applying may violate Naukri's ToS. Delays are human-ish. Use at your own risk.
 */
(async function naukriAutoApply() {
  'use strict';

  // Personal data is injected by the runner from .env (window.__APPLY_CONFIG); nothing PII is hard-coded here.
  const __CFG = (typeof window !== 'undefined' && window.__APPLY_CONFIG) || {};

  // ======================= CONFIG =======================
  const CONFIG = {
    DRY_RUN: true,             // true = open jobs + locate Apply but never click it. Flip to false when ready.
    MAX_APPLICATIONS: 15,      // stop after this many applications this run (tracked across pastes)
    EXTERNAL_BATCH: 4,         // queue this many "apply on company site" jobs, then yield to the runner
    // Wait between applications, randomised between min/max. Raised from 8-20s: an
    // hourly run only needs ~10 applications, so there is a whole hour to spread them
    // over, and a steady application every 10s is a far stronger automation signal
    // than anything the stealth plugin can hide. 10 jobs now take ~8-20 minutes.
    MIN_DELAY_MS: 45000,
    MAX_DELAY_MS: 120000,
    // DRY runs submit nothing, so they only need a short human-ish gap
    DRY_MIN_DELAY_MS: 5000,
    DRY_MAX_DELAY_MS: 15000,

    // Job titles to apply to (case-insensitive substring match on the job title)
    TITLE_KEYWORDS: [
      'data analyst', 'data analysis', 'power bi', 'business analyst',
      'bi analyst', 'business intelligence', 'reporting analyst',
      'data visualization', 'sql analyst', 'mis analyst', 'data reporting',
    ],
    // Skip jobs whose title contains any of these
    TITLE_BLOCKLIST: [
      'senior staff', 'principal', 'director', 'manager', 'lead', 'devops',
      'data engineer', 'qa', 'test', 'intern', 'designer', 'sales', 'marketing',
      '.net', 'c#', 'php', 'ruby', 'golang', 'ios', 'android native', 'flutter',
    ],
  };

  // No personal data and no answers live in this page. Every chatbot question goes to
  // the runner's answer engine (answer-engine.js, in Node) through __aaAnswer; if it
  // cannot establish a truthful answer the job is SKIPPED, never guessed.

  // ======================= HELPERS =======================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Instantly materialising a full sentence is the most obviously non-human thing
  // the script does. Insert it in 1-3 char bursts with jittered gaps instead.
  const typeLikeHuman = async (doc, text) => {
    for (let i = 0; i < text.length;) {
      const n = 1 + Math.floor(Math.random() * 3);
      doc.execCommand('insertText', false, text.slice(i, i + n));
      i += n;
      await sleep(45 + Math.random() * 95);
    }
  };
  const log = (...a) => console.log('%c[auto-apply]', 'color:#4a90d9;font-weight:bold', ...a);
  // Structured progress for the runner (__aaEvent). Fire-and-forget: never awaited, never throws.
  const emit = (state, data = {}) => {
    try { if (typeof window.__aaEvent === 'function') window.__aaEvent({ state, ...data }).catch(() => {}); } catch (e) { /* no runner */ }
  };
  const textOf = (root, sel) => (root?.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    return el && el.offsetParent !== null && !el.disabled;
  }

  function findButtonByText(root, regex) {
    return [...root.querySelectorAll('button, a, [role="button"], [type="submit"], div[class*="btn" i]')]
      .find((b) => visible(b) && regex.test(b.textContent.trim()) && b.textContent.trim().length < 40);
  }

  async function waitFor(fn, timeoutMs = 10000, pollMs = 300) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let res = null;
      try { res = fn(); } catch (e) { /* popup mid-navigation */ }
      if (res) return res;
      await sleep(pollMs);
    }
    return null;
  }

  /** Ask the runner. Missing binding or any error = unknown (never a local fallback). */
  async function askRunner(payload) {
    if (typeof window.__aaAnswer !== 'function') {
      return { status: 'unknown', category: 'unanswerable-question', missing: 'no answer engine (script not run by the runner)' };
    }
    try { return (await window.__aaAnswer(payload)) || { status: 'unknown', category: 'ai-error', missing: 'empty reply' }; }
    catch (e) { return { status: 'unknown', category: 'ai-error', missing: `answer engine error: ${e.message}` }; }
  }

  /** Something only a human can do, visible in the application popup right now. */
  function detectBlocker(d) {
    if (!d || !d.body) return null;
    if (d.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], .g-recaptcha, [class*="captcha" i]')) return 'captcha';
    if (/\b(enter|verify|resend) (the )?otp\b|one[- ]time password/i.test(d.body.innerText || '')) return 'otp';
    return null;
  }

  /** Best-effort job context for the answer engine (the popup shows the job page). */
  function jobContext(d, job) {
    const q = (s) => d?.querySelector(s)?.innerText?.trim() || '';
    return {
      id: job.id, title: job.title, company: job.company,
      description: (q('[class*="job-desc" i]') || q('[class*="JDC" i]') || q('section[class*="description" i]')).slice(0, 2500),
    };
  }

  // ======================= SELECTORS (edit here if Naukri changes) =======================
  const SELECTORS = {
    // job cards on the search results page
    jobCards: '.srp-jobtuple-wrapper, article.jobTuple',
    jobTitleLink: 'a.title',
    // job detail page (inside the popup)
    applyButtonText: /^apply(?:\s+now)?$/i,
    externalApplyText: /company site/i,
    alreadyAppliedText: /^applied/i,
    // what Naukri shows INSTEAD of the Apply button once applied (not a button at all)
    alreadyAppliedMarker: '#already-applied, .already-applied',
    // "you have already applied" deliberately NOT here — it's a duplicate-apply
    // rejection, not a new application; counting it inflated state.applied.
    appliedToast: /successfully applied|applied successfully|application sent|application submitted/i,
    alreadyAppliedToast: /you have already applied/i,
    // chatbot questionnaire drawer (appears after Apply on some jobs)
    chatbot: '[class*="chatbot" i], [class*="_drawer" i][class*="chat" i]',
    botMessage: '[class*="botMsg" i], [class*="bot-msg" i], [class*="message" i] span',
    chatInput: 'div[contenteditable="true"], [class*="chatbot" i] textarea, [class*="chatbot" i] input[type="text"]',
    chatSendText: /^send$|^save$|^submit$|^ok$|^done$/i,
    chatOption: '[class*="chatbot" i] label, [class*="chip" i], [class*="radio" i] label, [class*="checkbox" i] label',
    nextPageText: /^next$/i,
    noResults: '[class*="no-result-container" i]',
    // job page (measured 2026-09-28): header parts, the apply area, the employer link
    jobHeader: '[class*="jhc__"], [class*="jd-header-title" i]',
    applyArea: '[class*="apply-button-container" i]',
    employer: '[class*="jd-header-comp-name" i] a',
  };

  // ======================= CROSS-PASTE STATE =======================
  const STORE_KEY = 'autoApplyNaukri';
  let state;
  try { state = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { state = {}; }
  // Dry and live keep SEPARATE seen-lists. seen is recorded before the apply is even
  // attempted, so with one shared list every job a dry run walked was permanently
  // skipped by later live runs — the first live run opened with "16 already seen"
  // and had to page past inventory it had never actually applied to.
  const SEEN_KEY = CONFIG.DRY_RUN ? 'seenDry' : 'seen';
  if (!Array.isArray(state[SEEN_KEY])) state[SEEN_KEY] = [];
  if (typeof state.applied !== 'number') state.applied = 0;
  const saveState = () => localStorage.setItem(STORE_KEY, JSON.stringify(state));

  // Setup preferences (from the runner) replace the built-in title words and ADD to the
  // built-in blocklist; without Setup the lists above are used unchanged.
  const TF = __CFG.titleFilter || null;
  const KEYWORDS = TF && TF.keywords.length ? TF.keywords : CONFIG.TITLE_KEYWORDS;
  const BLOCKLIST = [...CONFIG.TITLE_BLOCKLIST, ...(TF ? TF.blocklist : [])];
  const titleOk = (t) => {
    const lower = t.toLowerCase();
    return KEYWORDS.some((k) => lower.includes(k)) &&
           !BLOCKLIST.some((k) => lower.includes(k));
  };
  // Preferred locations (Setup). Unknown card location = keep (can't tell); "remote"
  // cards pass when the user accepts remote work.
  const LF = __CFG.locationFilter || null;
  const locationOk = (loc) => {
    if (!LF || !LF.locations.length || !loc) return true;
    const l = loc.toLowerCase();
    return LF.locations.some((x) => l.includes(x.toLowerCase())) || (LF.remote && /remote|work from home/.test(l));
  };

  // ======================= CHATBOT QUESTIONNAIRE (inside popup) =======================
  // Returns true when the questionnaire closed, otherwise an intervention object
  // {category, question, options, missing, stage} — the caller records SKIPPED (or
  // FAILED for a transient ai-error). Nothing is ever guessed or defaulted.
  async function handleChatbot(doc, job) {
    const stop = (category, question, options, missing) => {
      log(`  ⏭ chatbot stopped — ${category}${missing ? `: ${missing}` : ''}`);
      return { category, question: question || '', options: options || [], missing: missing || '', stage: 'application questionnaire' };
    };
    let lastAnswered = null;
    for (let turn = 0; turn < 15; turn++) {
      await sleep(2500);
      const drawer = doc.querySelector(SELECTORS.chatbot);
      if (!drawer || !visible(drawer)) return true;    // chatbot gone → done
      const blocker = detectBlocker(doc);
      if (blocker) return stop(blocker, '', [], `${blocker} shown during the questionnaire`);

      // Latest bot question = last non-empty bot message in the drawer
      const msgs = [...drawer.querySelectorAll(SELECTORS.botMessage)]
        .map((m) => m.textContent.trim()).filter(Boolean);
      const question = msgs[msgs.length - 1] || drawer.textContent.trim().slice(0, 200);
      log(`  🤖 Q: "${question.slice(0, 80)}"`);
      // the same question again right after we answered it: our answer was not accepted
      if (lastAnswered && question === lastAnswered) return stop('unexpected-behaviour', question, [], 'the same question came back after it was answered');

      const options = [...drawer.querySelectorAll(SELECTORS.chatOption)].filter(visible)
        .filter((o) => o.textContent.trim().length > 0 && o.textContent.trim().length < 60);
      const input = options.length ? null : [...drawer.querySelectorAll(SELECTORS.chatInput)].filter(visible).pop();
      if (!options.length && !input) return stop('unsupported-form', question, [], 'no options and no input field found');
      const optionTexts = options.map((o) => o.textContent.trim());
      const numeric = !!input && (input.type === 'number' || /numeric|decimal/.test(input.inputMode || ''));
      const res = await askRunner({ question, options: optionTexts, numeric, job: jobContext(doc, job) });
      if (res.status !== 'answered') return stop(res.category || 'unanswerable-question', question, optionTexts, res.missing);

      if (options.length) {
        // only the option whose text IS the validated answer — never a default
        const pick = options.find((o) => o.textContent.trim() === res.answer);
        if (!pick) return stop('unexpected-behaviour', question, optionTexts, `answer "${res.answer}" matched no option element`);
        pick.scrollIntoView({ block: 'center', inline: 'center' });
        pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: doc.defaultView }));
        await sleep(100);
        pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: doc.defaultView }));
        await sleep(100);
        pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: doc.defaultView }));
        log(`  ☑ picked option: "${pick.textContent.trim().slice(0, 50)}" (${res.source}: ${String(res.evidence).slice(0, 60)})`);
      } else {
        // Free-text answer into the contenteditable / input
        const answer = res.answer;
        if (input.isContentEditable) {
          // execCommand performs a real edit, so the browser fires a trusted
          // input event; setting .textContent left the framework's state empty.
          // Verified in Chrome: inserts the text and fires `input`.
          input.focus();
          doc.getSelection().selectAllChildren(input);
          await typeLikeHuman(doc, String(answer));
        } else {
          const proto = input.tagName === 'TEXTAREA' ? doc.defaultView.HTMLTextAreaElement.prototype
                                                     : doc.defaultView.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        log(`  ✍ A: "${String(answer).slice(0, 60)}" (${res.source}: ${String(res.evidence).slice(0, 60)})`);
      }
      lastAnswered = question;
      emit('filling-answer', { jobId: job.id, question, answer: res.answer, text: 'answer filled' });

      await sleep(800);
      const send = findButtonByText(drawer, SELECTORS.chatSendText) ||
                   findButtonByText(drawer, /^next$|^continue$|^proceed$/i) ||
                   drawer.querySelector('[class*="send" i], button[type="submit"], input[type="submit"]');
      if (send) send.click();
      else {
        // some inputs submit on Enter
        const input = [...drawer.querySelectorAll(SELECTORS.chatInput)].filter(visible).pop();
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
    }
    return stop('manual-flow', '', [], 'questionnaire still open after 15 turns');
  }

  // ======================= APPLY TO ONE JOB (in popup) =======================
  let why = ''; // reason for the last `return false`, reported to the runner as FAILED
  let intervention = null; // details for the last `return 'skipped'`, reported as SKIPPED
  // true once this job's questionnaire opened: its FAILED reasons are tagged
  // "questionnaire-stage:" so the runner can cap repeated questionnaire failures
  let hadQuestionnaire = false;
  // {reason, extra} for a job ApplyIt deliberately doesn't apply to (low match, walk-in,
  // unsupported apply route, no online apply) — reported to the runner as SKIPPED
  let skip = null;
  /** Ask the runner's low-match gate. No runner (pasted by hand) or an error = go ahead. */
  async function checkMatch(job) {
    if (typeof window.__aaCheckMatch !== 'function') return { ok: true };
    try { return (await window.__aaCheckMatch(job.id)) || { ok: true }; } catch (e) { return { ok: true }; }
  }
  async function applyInPopup(popup, job) {
    popup.location.href = job.href;
    let loadedAt = 0;
    const applyBtn = await waitFor(() => {
      const doc = popup.document;
      if (!doc || !doc.body) return null;
      // Until the popup has actually navigated, popup.document is still the PREVIOUS
      // job — whose button may already read "Applied". Wait for this job's own page.
      if (/^\d+$/.test(job.id) && !doc.location.href.includes(job.id)) return null;
      if ([...doc.querySelectorAll(SELECTORS.alreadyAppliedMarker)]
        .some((e) => visible(e) && /^applied$/i.test(e.textContent.trim()))) return 'applied';
      if (findButtonByText(doc, SELECTORS.externalApplyText)) return 'external';
      const btn = findButtonByText(doc, SELECTORS.applyButtonText) ||
                  doc.querySelector('#apply-button, button[id*="apply" i]');
      if (btn && SELECTORS.alreadyAppliedText.test(btn.textContent.trim())) return 'applied';
      if (btn) return btn;
      // Fully loaded job page (its header is there) but no Apply / company-site control:
      // decide after a short grace instead of waiting 30 s (walk-ins, "I am interested").
      if (doc.readyState === 'complete' && doc.querySelector(SELECTORS.jobHeader)) {
        if (!loadedAt) loadedAt = Date.now();
        if (Date.now() - loadedAt > 1500) return 'no-apply';
      }
      return null;
    }, 30000);

    {
      const d = popup.document;
      // the job page's employer beats the card's label (cards can show an industry,
      // e.g. "IT Services and Consulting"); walk-in pages only have "hiring for"
      const employer = textOf(d, SELECTORS.employer);
      if (employer) job.company = employer;
      emit('opening-application', { jobId: job.id, text: 'job page open', job: { id: job.id, title: job.title, company: job.company }, details: {
        // class names measured on a live job page 2026-09-28 (styles_jhc__exp__…, …)
        location: textOf(d, '[class*="jhc__location__"]') || textOf(d, '[class*="jhc__loc__"]'),
        salary: textOf(d, '[class*="jhc__salary__"]'),
        experience: textOf(d, '[class*="jhc__exp__"]'),
        stats: textOf(d, '[class*="jhc__jd-stats__"]'),
        employer, hiringFor: textOf(d, '[class*="jhc__hiring-for" i]'),
        walkIn: textOf(d, '[class*="jhc__walkin__" i]') ? { when: textOf(d, '[class*="jhc__walkin__" i]'), venue: textOf(d, '[class*="jhc__venue" i]') } : null,
        description: jobContext(d, job).description,
      } });
    }
    // The card had no readable location: check it on the job page rather than letting it through.
    if (job.locationUnknown && applyBtn && LF) {
      const pageLoc = textOf(popup.document, '[class*="jhc__location__"]') || textOf(popup.document, '[class*="jhc__loc__"]');
      log(`  📍 card had no location; job page says: "${pageLoc || '(none)'}"`);
      if (pageLoc && !locationOk(pageLoc)) { why = `location "${pageLoc}" is not one of your cities`; return 'filtered'; }
    }
    if (!applyBtn) { log('  ⚠ no Apply button found — skipping.'); why = 'no Apply button within 30s'; return false; }
    if (applyBtn === 'no-apply') {
      const d = popup.document;
      const area = [...d.querySelectorAll(`${SELECTORS.applyArea} button, ${SELECTORS.applyArea} a`)].filter(visible)
        .map((b) => b.textContent.trim()).filter((t) => t && !/^save$/i.test(t));
      const buttons = [...d.querySelectorAll('button, a, [role="button"]')].filter(visible).map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 40);
      const other = area[0] || buttons.find((t) => /interest|register|apply|express|walk.?in/i.test(t) && !/^save$|send me jobs/i.test(t));
      log(`  🧾 no Apply / company-site control — visible buttons: ${JSON.stringify(buttons.slice(0, 12))}`);
      const walkIn = textOf(d, '[class*="jhc__walkin__" i]');
      skip = other
        ? { reason: `unsupported-apply-route: ${other}`, extra: { applyRoute: { control: other, buttons: buttons.slice(0, 12), walkIn: walkIn ? { when: walkIn, venue: textOf(d, '[class*="jhc__venue" i]') } : null } } }
        : { reason: 'no-online-apply', extra: { applyRoute: { control: null, buttons: buttons.slice(0, 12), walkIn: walkIn ? { when: walkIn, venue: textOf(d, '[class*="jhc__venue" i]') } : null } } };
      log(`  ⏭ ${skip.reason} — not clicking it`);
      return 'not-applicable';
    }
    // In-page JS can't follow the handoff to the employer's domain (cross-origin),
    // so hand the job to the Node runner, which applies on the company site itself.
    if (applyBtn === 'external') { log(`  🔗 EXTERNAL | ${job.title} | ${job.href}`); return 'external'; }
    if (applyBtn === 'applied') { log('  already applied — skipping.'); return 'already-applied'; }

    // Low-match gate — only now, after the Apply button check, so company-site and
    // no-button jobs never cost a match (or an AI call). Node decides.
    const gate = await checkMatch(job);
    if (!gate.ok) {
      skip = { reason: gate.reason, extra: { lowMatch: gate.match || null } };
      log(`  ⏭ ${gate.reason} — not applying`);
      return 'low-match';
    }

    if (CONFIG.DRY_RUN) {
      log(`  🔍 DRY_RUN — would click: "${applyBtn.textContent.trim()}". Set DRY_RUN=false to apply for real.`);
      return true;
    }

    // Click gate: Node decides (DRY never, TEST only allow-listed ids, LIVE when
    // confirmed). No binding, an error, or anything but an explicit true = no click.
    let allowed = false;
    try { allowed = typeof window.__aaMayClick === 'function' && (await window.__aaMayClick(job.id)) === true; } catch (e) { allowed = false; }
    if (!allowed) { log(`  🔒 click not allowed by the runner for ${job.id} — not submitting.`); return 'denied'; }
    emit('submitting', { jobId: job.id, text: 'clicking Apply' });

    applyBtn.scrollIntoView({ block: 'center', inline: 'center' });
    applyBtn.focus();
    applyBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: popup }));
    await sleep(100);
    applyBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: popup }));
    await sleep(100);
    applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: popup }));

    // popup.document MUST be re-read on every check. Clicking Apply can navigate the
    // popup, and a navigation replaces the Document object — the old code captured it
    // once, so from then on every check ran against a detached document: textContent
    // never carried the toast and applyBtn.isConnected was false. A genuinely
    // successful apply therefore reported "could not confirm success", and the
    // calibration dump printed an empty button list (the tell-tale of a dead
    // document). Dry runs return before the click, so only live runs ever hit it.
    const doc = () => popup.document;

    // Only the button we actually clicked counts as a state change. Scanning every
    // button for /^applied/i matched unrelated chrome ("Applied filters", an
    // already-applied entry in a similar-jobs rail) and confirmed a success that
    // never happened. If Naukri swaps the node out instead of relabelling it,
    // isConnected goes false and we fall back to the toast text.
    const confirmed = () => {
      const d = doc();
      if (!d || !d.body) return false;
      return /\/myapply\//i.test(d.location.href) ||
        SELECTORS.appliedToast.test(d.body.textContent) ||
        (applyBtn.isConnected && SELECTORS.alreadyAppliedText.test(applyBtn.textContent.trim()));
    };

    // Race the questionnaire drawer against the applied confirmation, whichever
    // lands first. A fixed sleep raced the drawer's render and silently skipped
    // the questions; polling the drawer alone stalled the full timeout on every
    // direct apply, which is the common case.
    const outcome = await waitFor(() => {
      const d = doc();
      if (!d || !d.body) return null;
      if (SELECTORS.alreadyAppliedToast.test(d.body.textContent)) return 'duplicate';
      if (detectBlocker(d)) return 'blocker';
      const drawer = d.querySelector(SELECTORS.chatbot);
      if (drawer && visible(drawer)) return 'chatbot';
      return confirmed() ? 'applied' : null;
    }, 10000);
    if (outcome === 'duplicate') { log('  ↩ already applied to this job — not counting it.'); return 'already-applied'; }
    if (outcome === 'blocker') {
      const category = detectBlocker(doc()) || 'unexpected-behaviour';
      intervention = { category, question: '', options: [], missing: `${category} shown after clicking Apply`, stage: 'after Apply click' };
      return 'skipped';
    }
    if (outcome === 'chatbot') {
      hadQuestionnaire = true;
      const res = await handleChatbot(doc(), job);
      if (res !== true) {
        // AI failures are retryable (FAILED); everything else needs a human (SKIPPED)
        if (res.category === 'ai-error') { why = `questionnaire-stage: ai-error: ${res.missing}`; return false; }
        // AI quota gone for the day: retryable FAILED, not a questionnaire failure (no cap), and the runner stops
        if (res.category === 'ai-daily-limit') { why = `ai-daily-limit: ${res.missing}`; return false; }
        intervention = res;
        return 'skipped';
      }
    }

    // Confirm success (toast or Apply button turned into "Applied")
    const success = outcome === 'applied' || await waitFor(confirmed, 10000);
    if (success) {
      log('  ✅ applied');
    } else {
      // The confirmation wording is the one thing we could not verify without a real
      // apply. Dump what the page actually said so the regex can be calibrated
      // instead of guessing again.
      const d = doc();
      // An external job can render a generic "Apply" before its real
      // "Apply on company site" control exists, so the pre-click external check
      // sometimes passes too early and we click the wrong button. Re-check now:
      // if the page is in fact external, hand it to the runner's external queue
      // (which applies on the employer's own site) instead of burning it as an
      // unexplained failure. Observed live on fafadia-tech, whose calibration dump
      // read: visible buttons ["2","Save","Apply on company site"].
      if (d && findButtonByText(d, SELECTORS.externalApplyText)) {
        log(`  🔗 EXTERNAL | ${job.title} | ${job.href}`);
        return 'external';
      }
      const btns = d && d.body ? [...d.querySelectorAll('button')].filter(visible)
        .map((b) => b.textContent.trim()).filter(Boolean).slice(0, 8) : [];
      log('  ⚠ could not confirm success — check the popup.');
      why = (hadQuestionnaire ? 'questionnaire-stage: ' : '') + 'no confirmation after clicking Apply';
      log(`  🔬 calibration — url: ${d ? d.location.href.slice(0, 120) : '(no document)'}`);
      log(`  🔬 calibration — visible buttons: ${JSON.stringify(btns)}`);
      log(`  🔬 calibration — page text: "${d && d.body ? d.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : ''}"`);
    }
    return !!success;
  }

  // ======================= MAIN LOOP =======================
  log(`Starting. DRY_RUN=${CONFIG.DRY_RUN}, wanted this run=${CONFIG.MAX_APPLICATIONS}, excluded ids: ${(__CFG.excluded || []).length}`);
  if (!/naukri\./.test(location.hostname)) { log('⚠ Open a naukri.com job search first.'); return; }

  // Naukri renders the results list client-side, so the cards are not in the DOM
  // at injection time. Without this wait the first loop pass saw 0 cards, found no
  // "Next" button either, and exited with "No more pages" a second after starting.
  const waitForCards = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ([...document.querySelectorAll(SELECTORS.jobCards)].filter(visible).length) return true;
      // Naukri's empty-search page (measured 2026-09-28): "No results found"
      if ([...document.querySelectorAll(SELECTORS.noResults)].some(visible)) return 'empty';
      await sleep(500);
    }
    return false;
  };
  const cardsState = await waitForCards();
  if (cardsState === 'empty') {
    // an empty search is finished, not broken: the runner moves on to the next search
    log('(this page: 0 cards — Naukri says "No results found" for this search)');
    log('No more pages. Change your search and paste again.');
    return;
  }
  if (!cardsState) {
    log('No job cards rendered after 30s — search page may have changed or been blocked.');
    return;
  }

  const popup = window.open('about:blank', 'naukriApplyPopup', 'width=1250,height=900');
  if (!popup) {
    log('🚫 POPUP BLOCKED. Allow popups for naukri.com (address-bar icon → Always allow), then paste again.');
    return;
  }

  // Ledger mode (runner): Node owns every count. The browser only knows how many
  // verified applications are still wanted THIS run and which job ids are off-limits
  // (permanent APPLIED/SKIPPED + this run's attempts). state.applied is no longer used.
  const EXCLUDED = new Set(__CFG.excluded || []);
  const idOf = window.__aaJobId || ((u) => u);
  let remaining = CONFIG.MAX_APPLICATIONS;
  const report = async (job, status, reason, extra = {}) => {
    if (typeof window.__aaReport !== 'function') return null; // pasted by hand: no runner
    try {
      return await window.__aaReport({ url: job.href, title: job.title, company: job.company, route: 'naukri', status, reason, ...extra });
    } catch (e) { log('  report to runner failed:', e.message); return null; }
  };

  // Pause/Stop from the app: the runner holds this call while paused and answers false
  // on stop. No runner (pasted by hand) = always go.
  const mayStartJob = async () => {
    if (typeof window.__aaMayStartJob !== 'function') return true;
    try { return (await window.__aaMayStartJob()) === true; } catch (e) { return false; }
  };

  // Duplicate postings: the same company with a near-identical title (e.g. one walk-in
  // advertised for five towns) — only the first one is opened in a run.
  const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
  const nearSame = (a, b) => { const x = words(a), y = words(b); let n = 0; for (const w of x) if (y.has(w)) n++; return x.size && y.size && n / (x.size + y.size - n) >= 0.8; };
  const opened = [...(__CFG.openedPostings || [])];
  const isDuplicate = (company, title) => !!company && opened.some((o) => o.company.toLowerCase() === company.toLowerCase() && nearSame(o.title, title));

  // Per-page counts for the run log (Part G): what the page offered and what happened to it.
  let openedOnPage = 0;
  let last = { cards: 0, excluded: 0, titleFiltered: 0, locationFiltered: 0, duplicates: 0 };
  const pageSummary = (end) => emit('page-summary', { text: end, page: location.href,
    counts: { seen: last.cards, titleFiltered: last.titleFiltered, excluded: Math.max(0, last.excluded - openedOnPage - last.duplicates),
      locationFiltered: last.locationFiltered, duplicates: last.duplicates, opened: openedOnPage } });

  let extQueued = 0;
  while (remaining > 0) {
    if (!(await mayStartJob())) { log('⏹ stopped by the runner — no new job started.'); pageSummary('stopped'); break; }
    const cards = [...document.querySelectorAll(SELECTORS.jobCards)].filter(visible);
    let job = null;

    let nSeen = 0, nFiltered = 0, nLoc = 0, nDup = 0;
    // TEST: allow-listed job URLs given on the command line come first, opened directly
    const direct = (__CFG.directJobs || []).find((d) => d.id && !EXCLUDED.has(d.id));
    if (direct) job = { href: direct.href, id: direct.id, title: '(test job)', company: '', card: null };
    for (const card of (job ? [] : cards)) {
      const link = card.querySelector(SELECTORS.jobTitleLink);
      if (!link) continue;
      const title = link.textContent.replace(/\s+/g, ' ').trim();
      if (EXCLUDED.has(idOf(link.href))) { nSeen++; continue; }
      if (!titleOk(title)) { nFiltered++; continue; }
      const cardLoc = textOf(card, '.locWdth');
      if (!locationOk(cardLoc)) { nLoc++; continue; }
      const company = (card.querySelector('.comp-name, [class*="comp-name" i]')?.textContent || '').trim();
      if (isDuplicate(company, title)) { nDup++; EXCLUDED.add(idOf(link.href)); log(`  ⧉ duplicate posting skipped: ${title} — ${company}`); continue; }
      // no readable location on the card: it is checked on the job page instead
      job = { href: link.href, id: idOf(link.href), title, company, card, locationUnknown: !cardLoc };
      break;
    }
    last = { cards: cards.length, excluded: nSeen, titleFiltered: nFiltered, locationFiltered: nLoc, duplicates: last.duplicates + nDup };
    if (job) emit('checking-job', { jobId: job.id, text: 'checking job',
      job: { id: job.id, title: job.title, company: job.company, url: job.href },
      details: job.card ? {
        location: textOf(job.card, '.locWdth'),
        experience: textOf(job.card, '.expwdth'),
        tags: [...job.card.querySelectorAll('li.tag-li')].map((li) => li.innerText.trim()).filter(Boolean),
      } : {} });

    if (!job) {
      const sample = cards.slice(0, 3).map((c) =>
        `"${(c.querySelector(SELECTORS.jobTitleLink)?.textContent || '?').trim().slice(0, 40)}"`).join(', ');
      // Split the two very different reasons for "nothing to do here": jobs already
      // visited on an earlier run vs jobs the title filter rejected. Reporting a
      // combined "0 match" made an exhausted page look like a broken filter.
      log(`(this page: ${cards.length} cards — ${nSeen} excluded (applied/skipped/tried), ${nFiltered} title-filtered, ${nLoc} location-filtered, ${last.duplicates} duplicates, ${openedOnPage} opened; sample: ${sample})`);
      const nextBtn = findButtonByText(document, SELECTORS.nextPageText);
      pageSummary(nextBtn ? 'next page' : 'last page');
      if (nextBtn) {
        log('🌐 Next results page — the page will reload. PASTE THE SCRIPT AGAIN when it loads.');
        popup.close();
        nextBtn.click();
        return;
      }
      log('No more pages. Change your search and paste again.');
      break;
    }

    EXCLUDED.add(job.id); // never twice in one injection, whatever the outcome
    state[SEEN_KEY].push(job.href); // legacy; no longer read for exclusion
    saveState();
    openedOnPage++;
    opened.push({ company: job.company, title: job.title }); // duplicates are judged on the card's company
    log(`▶ Applying: ${job.title} | ${job.href}`);
    job.card?.scrollIntoView({ block: 'center' });

    why = '';
    intervention = null;
    hadQuestionnaire = false;
    skip = null;
    const ok = await applyInPopup(popup, job);
    // Strictly true: 'external' is truthy and must not be counted as an application.
    // A claim is only a claim: the runner re-verifies it and answers with what is left.
    if (ok === true || ok === 'already-applied') {
      const v = await report(job, 'APPLIED', ok === true ? (CONFIG.DRY_RUN ? 'dry-run' : 'confirmed in page') : 'already-applied',
        { questionnaire: hadQuestionnaire });
      if (v) remaining = v.remaining;
      else if (ok === true) remaining--; // no runner: count locally
      log(`  remaining this run: ${remaining}`);
    } else if (ok === false) {
      await report(job, 'FAILED', why || 'unknown');
    } else if (ok === 'skipped') {
      // Apply WAS clicked; the runner stores the details and, after a SKIPPED, looks
      // at what Naukri now shows for the job (history only — counts are untouched).
      await report(job, 'SKIPPED', `human-needed: ${intervention.category}`, { intervention, clicked: true });
    } else if (ok === 'low-match' || ok === 'not-applicable') {
      // deliberately not applied (no click happened): low match score, walk-in /
      // unsupported apply route, or no online apply at all
      await report(job, 'SKIPPED', skip.reason, { ...skip.extra, clicked: false });
    } else if (ok === 'filtered') {
      // not one of the user's cities after all (read on the job page) — nothing to record
      emit('filtered', { jobId: job.id, text: why });
    }
    // ok === 'denied': the click gate said no — nothing happened, nothing to record
    if (ok === 'external') {
      extQueued++;
      // The runner applies on the employer's own site, but it can only do that while
      // this script is idle: its queue drains under !anyBusy, and applyExternal waits
      // for the next context 'page' event, which would otherwise capture the job popup
      // this script drives. Most naukri developer listings are external, so a loop that
      // runs to MAX_APPLICATIONS keeps the script busy and the queue never drains at
      // all. Hand control back after a small batch instead.
      if (extQueued >= CONFIG.EXTERNAL_BATCH) {
        log(`↩ queued ${extQueued} external jobs — yielding so the runner can apply to them.`);
        break;
      }
    }
    // Pacing: pause only after a real or simulated apply (DRY: short). Skipped, deferred,
    // filtered, no-button and already-applied jobs go straight to the next card.
    if (ok === true && remaining > 0) {
      const [lo, hi] = CONFIG.DRY_RUN ? [CONFIG.DRY_MIN_DELAY_MS, CONFIG.DRY_MAX_DELAY_MS] : [CONFIG.MIN_DELAY_MS, CONFIG.MAX_DELAY_MS];
      const pause = lo + Math.random() * (hi - lo);
      emit('waiting', { text: `pausing ${Math.round(pause / 1000)}s before the next job`, ms: Math.round(pause) });
      await sleep(pause);
    }
  }
  if (remaining <= 0) pageSummary('run target reached');

  popup.close();
  log(CONFIG.DRY_RUN
    ? 'DRY RUN finished — nothing was actually sent. Set CONFIG.DRY_RUN = false and re-paste to apply for real.'
    : `Finished. ${remaining} still wanted this run.`);
})();
