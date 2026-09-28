/**
 * Permanent record of every Naukri job the bot finished with: one JSON object per
 * line in naukri-ledger.jsonl, append-only. Only final outcomes are written:
 *   APPLIED  verified submission          counts toward today, excluded forever
 *   SKIPPED  needs a human / not eligible excluded forever, never counts
 *   FAILED   anything else                never counts, NOT excluded (retry later)
 * Every function takes an optional file path so tests never touch the real ledger.
 */
const path = require('path');
const { readJsonl, appendJsonl } = require('./jsonl');

const LEDGER = path.join(__dirname, 'naukri-ledger.jsonl');
const STATUSES = ['APPLIED', 'SKIPPED', 'FAILED'];

/** Local calendar day, YYYY-MM-DD. Not toISOString(): that is UTC, and 00:00-05:30 IST would land on yesterday. */
const dayOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Stable identity of a job. Naukri job URLs end in a numeric id
 * (…-3-to-8-years-040926023453?src=…&sid=…); query and hash are search-specific
 * and ignored. Without a numeric id, the URL minus query/hash is the identity.
 */
function jobId(url) {
  const bare = String(url || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  const m = bare.match(/-(\d{8,})$/);
  if (m) return m[1];
  try { const u = new URL(bare); return (u.origin + u.pathname).replace(/\/+$/, ''); } catch (e) { return bare; }
}

/** All well-formed records. Creates the file if missing; skips blank and corrupt lines. */
function load(file = LEDGER) {
  return readJsonl(file).filter((r) => STATUSES.includes(r.status) && r.jobId);
}

/**
 * Append one final outcome. Only whitelisted fields are stored (no CV data can leak
 * in). One appendFileSync of one short line: O_APPEND never rewrites earlier bytes,
 * so an interruption can at worst leave THIS line torn, and the next append starts
 * on a fresh line so a torn tail cannot swallow it.
 */
function append(record, file = LEDGER) {
  if (!STATUSES.includes(record.status)) throw new Error(`ledger: bad status ${record.status}`);
  const now = new Date();
  const rec = {
    ts: record.ts || now.toISOString(),
    day: record.day || dayOf(now),
    jobId: record.jobId || jobId(record.url),
    url: String(record.url || '').split(/[?#]/)[0],
    title: String(record.title || ''),
    company: String(record.company || ''),
    route: String(record.route || 'naukri'),
    status: record.status,
    reason: String(record.reason || ''),
  };
  if (!rec.jobId) throw new Error('ledger: record has no url/jobId');
  return appendJsonl(file, rec);
}

/**
 * Verified applications on the given local day. SKIPPED and FAILED never count, and
 * neither does APPLIED/already-applied: that records an application made before,
 * found today, and was never one of today's submissions.
 */
const todayApplied = (records = load(), now = new Date()) =>
  records.filter((r) => r.status === 'APPLIED' && r.day === dayOf(now) && r.reason !== 'already-applied').length;

/** Job ids never to attempt again: every APPLIED or SKIPPED. Historical FAILED stays retryable. */
const excludedIds = (records = load()) =>
  new Set(records.filter((r) => r.status === 'APPLIED' || r.status === 'SKIPPED').map((r) => r.jobId));

/**
 * Questionnaire-stage failures. FAILED stays retryable, but a job whose questionnaire
 * has FAILED `limit` times is not clicked again: its next attempt is recorded SKIPPED
 * (human-needed) instead. FAILED reasons from that stage start with QUESTIONNAIRE_STAGE.
 */
const QUESTIONNAIRE_STAGE = 'questionnaire-stage:';
const REPEATED_QUESTIONNAIRE_FAILURE = 'human-needed: repeated-questionnaire-failure';
const QUESTIONNAIRE_FAILURE_LIMIT = 2;
function questionnaireFailures(records, id) {
  return records.filter((r) => r.jobId === id && r.status === 'FAILED' && String(r.reason).startsWith(QUESTIONNAIRE_STAGE)).length;
}
/** Job ids whose next attempt must be SKIPPED rather than retried. */
function repeatedQuestionnaireFailures(records, limit = QUESTIONNAIRE_FAILURE_LIMIT) {
  const done = excludedIds(records); // already APPLIED/SKIPPED: nothing to cap
  const out = new Set();
  for (const r of records) {
    if (!done.has(r.jobId) && questionnaireFailures(records, r.jobId) >= limit) out.add(r.jobId);
  }
  return out;
}

/**
 * One run's view of the ledger, loaded once at startup. `today` (daily cap) and
 * `submitted` (per-run cap) only move when an APPLIED line has actually been written
 * with count:true. `excluded` = permanent APPLIED/SKIPPED ids plus, in memory only,
 * anything recorded or handed off during this run (so a FAILED job is not retried
 * until a later run).
 */
function startRun({ file = LEDGER, now = new Date(), dailyCap = 50, perRun = 10 } = {}) {
  const records = load(file);
  const run = {
    today: todayApplied(records, now),
    submitted: 0,
    excluded: excludedIds(records),
    remaining: () => run.target - run.submitted,
    record(rec, { count = false } = {}) {
      const r = append(rec, file); // throws → nothing below runs, nothing is counted
      run.excluded.add(r.jobId);
      const counted = count && r.status === 'APPLIED';
      if (counted) { run.today++; run.submitted++; }
      return { ...r, counted };
    },
    /** What the injected browser script receives in window.__APPLY_CONFIG. */
    browserConfig: () => ({ excluded: [...run.excluded] }),
  };
  run.target = Math.max(0, Math.min(perRun, dailyCap - run.today));
  return run;
}

module.exports = { LEDGER, STATUSES, dayOf, jobId, load, append, todayApplied, excludedIds, startRun,
  QUESTIONNAIRE_STAGE, REPEATED_QUESTIONNAIRE_FAILURE, QUESTIONNAIRE_FAILURE_LIMIT, questionnaireFailures, repeatedQuestionnaireFailures };
