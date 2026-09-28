/**
 * Saved run logs (git-ignored): runs/<runId>.log (every log line) and
 * runs/<runId>.events.jsonl (every structured event, per-page counts, the stop reason).
 * Append-only and best-effort: a write error never breaks a run.
 */
const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(__dirname, 'runs');

function createRunLog(runId, dir = RUNS_DIR) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best effort */ }
  const logPath = path.join(dir, `${runId}.log`);
  const eventsPath = path.join(dir, `${runId}.events.jsonl`);
  const pages = [];
  const write = (file, text) => { try { fs.appendFileSync(file, text); } catch (e) { /* never break a run */ } };
  return {
    logPath, eventsPath, pages,
    line(text) { write(logPath, String(text) + '\n'); },
    event(ev) { write(eventsPath, JSON.stringify(ev) + '\n'); },
    /** {page, counts: {seen, titleFiltered, excluded, locationFiltered, duplicates, opened}, text} */
    pageSummary(s) {
      pages.push({ page: s.page, end: s.text, ...(s.counts || {}) });
      const c = s.counts || {};
      write(logPath, `[page] ${s.page} — seen ${c.seen}, title-filtered ${c.titleFiltered}, excluded ${c.excluded}, ` +
        `location-filtered ${c.locationFiltered}, duplicates ${c.duplicates}, opened ${c.opened} (${s.text})\n`);
    },
    /** Final record: why the run ended + the per-page table. */
    finish(summary) {
      write(eventsPath, JSON.stringify({ type: 'run-summary', ts: new Date().toISOString(), runId, ...summary, pages }) + '\n');
      write(logPath, `[end] ${summary.reason} — ${JSON.stringify(summary.counts || {})}\n`);
    },
  };
}

module.exports = { RUNS_DIR, createRunLog };
