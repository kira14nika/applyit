/**
 * Safety rails for the runner. Pure functions, so they are unit-tested.
 *
 *   DRY   (default)                 nothing is ever clicked or written
 *   TEST  --test --only=<id|url,…>  real clicks ONLY for the allow-listed job ids
 *   LIVE  --live --confirm-live     real applications (or type LIVE at the prompt)
 */
const { jobId } = require('./naukri-ledger');

/** Parse the CLI into a mode policy. Throws on ambiguous or incomplete input. */
function parseMode(argv) {
  const has = (f) => argv.includes(f);
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (has('--live') && has('--test')) throw new Error('choose one of --live or --test, not both');
  if (has('--test')) {
    if (!only.length) throw new Error('--test needs --only=<jobId|jobUrl,...>');
    const allow = new Set(only.map((x) => (/^https?:\/\//i.test(x) ? jobId(x) : x)));
    const directUrls = only.filter((x) => /^https?:\/\//i.test(x));
    return { mode: 'TEST', allow, directUrls, confirmed: true };
  }
  if (only.length) throw new Error('--only is only valid together with --test');
  if (has('--live')) return { mode: 'LIVE', allow: null, directUrls: [], confirmed: has('--confirm-live') };
  return { mode: 'DRY', allow: null, directUrls: [], confirmed: true };
}

/**
 * The click gate. The page asks before every real Apply click; anything but an
 * explicit true means "do not click". DRY always denies.
 */
function mayClick(policy, id) {
  if (!policy || !id) return false;
  if (policy.mode === 'LIVE') return policy.confirmed === true;
  if (policy.mode === 'TEST') return policy.allow instanceof Set && policy.allow.has(String(id));
  return false;
}

/**
 * Errors that are known, harmless races: the stealth plugin's CDP session or a
 * Playwright call outliving a page that navigated or closed. Everything else is a
 * real error and must be surfaced.
 */
const BENIGN = /Target page, context or browser has been closed|Target closed|Execution context was destroyed|frame was detached|Navigation failed because page was closed|cdpSession\.send|Session closed|browser has disconnected/i;
const isBenignRace = (e) => BENIGN.test(String((e && (e.stack || e.message)) || e));

/**
 * TEST and LIVE may only start when at least one AI provider passed its check (a real
 * Apply click can lead to a questionnaire). Only one working → start, with a warning
 * (no fallback). DRY never clicks, so it may run without any key.
 * `checks` is ai-providers check(): {gemini: {ok, reason, model}, groq: {…}}.
 */
function aiPreflight(mode, checks) {
  if (mode === 'DRY') return { ok: true };
  const entries = Object.entries(checks || {});
  const working = entries.filter(([, c]) => c && c.ok === true).map(([n]) => n);
  const why = entries.map(([n, c]) => `${n}: ${(c && c.reason) || 'not checked'}`).join('; ') || 'check not run';
  if (!working.length) return { ok: false, reason: `${mode} needs a working AI provider — ${why}. Fix .env, then run: node answer-engine.js --check` };
  const broken = entries.filter(([, c]) => !(c && c.ok === true));
  return { ok: true, working,
    warning: broken.length ? `only ${working.join(', ')} works (${broken.map(([n, c]) => `${n}: ${(c && c.reason) || 'not checked'}`).join('; ')}) — no fallback if it hits a limit` : null };
}

module.exports = { parseMode, mayClick, isBenignRace, aiPreflight };
