/**
 * Turn what the window asked for into the runner's own CLI flags — the same flags a
 * user would type, so every safety rail in safety.js still applies. Throws on anything
 * unexpected; LIVE requires the literal word LIVE typed by the user.
 */
function runnerArgs(opts = {}) {
  const mode = String(opts.mode || 'DRY').toUpperCase();
  const args = ['naukri'];
  if (mode === 'TEST') {
    const only = String(opts.only || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!only.length) throw new Error('TEST mode needs at least one job ID or job URL');
    const bad = only.filter((x) => !/^\d{8,}$/.test(x) && !/^https:\/\/www\.naukri\.com\/job-listings-[^\s,]+$/i.test(x));
    if (bad.length) throw new Error(`not a Naukri job ID or job URL: ${bad.join(', ')}`);
    args.push('--test', `--only=${only.join(',')}`);
  } else if (mode === 'LIVE') {
    if (opts.confirmText !== 'LIVE') throw new Error('LIVE needs the word LIVE typed to confirm');
    args.push('--live', '--confirm-live');
  } else if (mode !== 'DRY') throw new Error(`unknown mode ${mode}`);
  if (opts.showBrowser) args.push('--show');
  return { mode, args };
}

module.exports = { runnerArgs };
