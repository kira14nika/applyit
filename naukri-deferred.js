/**
 * Jobs that can only be applied to on the company's own site. Company-site applying
 * is paused, so these are parked here — NOT in the ledger (they are not SKIPPED and
 * must not count or be permanently closed) — and excluded from later runs so they
 * are not re-opened every run. A future company-site phase can read this list.
 */
const path = require('path');
const { readJsonl, appendJsonl } = require('./jsonl');
const { jobId, dayOf } = require('./naukri-ledger');

const DEFERRED = path.join(__dirname, 'naukri-deferred.jsonl');

const load = (file = DEFERRED) => readJsonl(file).filter((r) => r.jobId);
const ids = (records = load()) => new Set(records.map((r) => r.jobId));

/** Park one job. No-op (returns null) if it is already parked. */
function defer({ url, title = '', company = '', reason = 'company-site apply' }, file = DEFERRED, known = ids(load(file))) {
  const id = jobId(url);
  if (!id || known.has(id)) return null;
  known.add(id);
  const now = new Date();
  return appendJsonl(file, {
    ts: now.toISOString(), day: dayOf(now), jobId: id, url: String(url).split(/[?#]/)[0],
    title: String(title), company: String(company), route: 'external', reason: String(reason),
  });
}

module.exports = { DEFERRED, load, ids, defer };
