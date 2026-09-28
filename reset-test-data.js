/**
 * "Reset test data" (Settings > Advanced): MOVES development/test data into
 * archive/<timestamp>/ so a fresh history starts. Nothing is deleted.
 *
 * Archived: naukri-history.jsonl, runs/ (saved run logs), ai-state.json (AI daily-limit markers).
 * NEVER touched: naukri-ledger.jsonl, naukri-deferred.jsonl, profile.json, preferences.json.
 *
 * (The old in-page "seen" lists live in the Chrome profile's localStorage and have not been
 * used for anything since the ledger took over exclusion — there is nothing to archive.)
 */
const fs = require('fs');
const path = require('path');

const ARCHIVED = ['naukri-history.jsonl', 'runs', 'ai-state.json'];
const PROTECTED = ['naukri-ledger.jsonl', 'naukri-deferred.jsonl', 'profile.json', 'preferences.json'];

function resetTestData({ root = __dirname, now = new Date() } = {}) {
  for (const p of ARCHIVED) if (PROTECTED.includes(p)) throw new Error(`refusing to archive protected file ${p}`);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(root, 'archive', stamp);
  const moved = [];
  for (const name of ARCHIVED) {
    const src = path.join(root, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(src, path.join(archiveDir, name));
    moved.push(name);
  }
  return { archiveDir: moved.length ? archiveDir : null, moved, protected: PROTECTED.filter((n) => fs.existsSync(path.join(root, n))) };
}

module.exports = { ARCHIVED, PROTECTED, resetTestData };
