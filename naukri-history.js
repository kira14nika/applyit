/**
 * naukri-history.jsonl — the detail sidecar to the ledger. One JSON object per line,
 * keyed by runId + jobId. It NEVER affects counts or exclusions: the ledger stays the
 * only authority. Keep-more-information is deliberate for the development version.
 */
const path = require('path');
const { readJsonl, appendJsonl } = require('./jsonl');

const HISTORY = path.join(__dirname, 'naukri-history.jsonl');

/** A short, sortable, unique-enough id for one runner process. */
const newRunId = (now = new Date()) =>
  now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '') + '-' + Math.random().toString(36).slice(2, 6);

function append(record, file = HISTORY) {
  if (!record || !record.type) throw new Error('history: record needs a type');
  return appendJsonl(file, { ts: new Date().toISOString(), ...record });
}

const load = (file = HISTORY) => readJsonl(file);

module.exports = { HISTORY, newRunId, append, load };
