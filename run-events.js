/**
 * Structured run events (PLAN §14) and the per-job history they build.
 *
 *   bus = createBus({runId, mode, send})   EventEmitter; every event also goes to
 *                                          process.send when the runner is forked
 *   bus.emit(state, data)                  → {runId, seq, ts, state, ...data}
 *   bus.snapshot                           latest phase, job, counts, tallies (for the UI)
 *
 *   tracker = createTracker({bus, write})  collects one job's timeline, questions,
 *   tracker.event(jobId, state, data)      answers and details, and writes ONE history
 *   tracker.finish(jobId, outcome)         record when the job reaches an outcome.
 *
 * Events and history are observation only: counts come from the ledger (run.* numbers
 * are copied into the snapshot, never computed here).
 */
const { EventEmitter } = require('events');

const STATES = [
  'starting', 'searching', 'loading-results', 'checking-job', 'ai-matching',
  'opening-application', 'filling-application', 'generating-answer', 'filling-answer',
  'submitting', 'waiting', 'verifying', 'application-verified', 'already-applied',
  'skipped', 'failed', 'deferred', 'would-apply', 'paused', 'resumed', 'stopped', 'completed', 'error',
  'filtered', 'page-summary',
];
// outcome states that end a job and bump a per-run tally ('would-apply' = DRY run only)
const TALLY = { 'application-verified': 'applied', 'already-applied': 'alreadyApplied', skipped: 'skipped', failed: 'failed', deferred: 'deferred', 'would-apply': 'wouldApply' };
// states the page may report through __aaEvent; everything else is Node's to say
const PAGE_STATES = ['checking-job', 'opening-application', 'submitting', 'filling-answer', 'waiting', 'filtered', 'page-summary'];

function createBus({ runId, mode, send = typeof process.send === 'function' ? (m) => process.send(m) : null } = {}) {
  const em = new EventEmitter();
  let seq = 0;
  const snapshot = {
    runId, mode, state: 'starting', paused: false, phaseText: '', job: null, search: null, page: null,
    counts: { run: 0, target: 0, today: 0, dailyCap: 0 },
    tallies: { applied: 0, alreadyApplied: 0, skipped: 0, failed: 0, deferred: 0, wouldApply: 0 },
    question: null, lastResult: null, updatedAt: null,
  };
  em.snapshot = snapshot;
  em.emitState = (state, data = {}) => {
    if (!STATES.includes(state)) throw new Error(`run-events: unknown state "${state}"`);
    const ev = { runId, seq: ++seq, ts: new Date().toISOString(), state, ...data };
    snapshot.state = state;
    snapshot.updatedAt = ev.ts;
    // paused is a condition, not just the latest event: later events (the job in flight
    // finishing, the page's own wait) must not make a paused run look like it is running
    if (state === 'paused') snapshot.paused = true;
    if (state === 'resumed' || state === 'stopped' || state === 'completed') snapshot.paused = false;
    if (data.job) snapshot.job = { ...(snapshot.job || {}), ...data.job };
    if (data.search !== undefined) snapshot.search = data.search;
    if (data.page !== undefined) snapshot.page = data.page;
    if (data.counts) Object.assign(snapshot.counts, data.counts);
    if (data.text !== undefined) snapshot.phaseText = data.text;
    if (state === 'checking-job') { snapshot.match = null; snapshot.question = null; }
    if (data.match) snapshot.match = data.match;
    if (state === 'generating-answer') snapshot.question = { question: data.question, answer: null };
    if (state === 'filling-answer' && snapshot.question) snapshot.question.answer = data.answer;
    if (TALLY[state]) {
      snapshot.tallies[TALLY[state]]++;
      snapshot.lastResult = { state, job: snapshot.job, reason: data.reason || '' };
    }
    em.emit('event', ev);
    if (send) { try { send({ type: 'event', event: ev, snapshot }); } catch (e) { /* parent gone */ } }
    return ev;
  };
  return em;
}

function createTracker({ bus, write }) {
  const jobs = new Map();
  const get = (id) => {
    if (!jobs.has(id)) jobs.set(id, { jobId: id, details: {}, timeline: [], questions: [] });
    return jobs.get(id);
  };
  return {
    has: (id) => jobs.has(id),
    details: (id) => (jobs.has(id) ? jobs.get(id).details : null),
    /** Merge job facts (title, company, location, salary, experience, description, search, page). */
    touch(id, details = {}) { if (id) Object.assign(get(id).details, details); },
    /** Emit a state and add it to the job's timeline. */
    event(id, state, data = {}) {
      const ev = bus.emitState(state, { ...data, jobId: id || undefined });
      if (id) get(id).timeline.push({ ts: ev.ts, state, text: data.text || data.reason || '' });
      return ev;
    },
    /** Record one question/answer exchange for the job. */
    question(id, entry) { if (id) get(id).questions.push({ ts: new Date().toISOString(), ...entry }); },
    /** The job reached an outcome: emit it and write one history record. */
    finish(id, outcome, state) {
      const j = get(id);
      if (state) this.event(id, state, { reason: outcome.reason, job: { id, ...pick(j.details) } });
      const rec = { type: 'job', jobId: id, ...j.details, timeline: j.timeline, questions: j.questions, outcome };
      jobs.delete(id);
      try { write(rec); } catch (e) { /* history must never break a run */ }
      return rec;
    },
  };
}

const pick = (d) => ({ title: d.title, company: d.company, url: d.url });

module.exports = { STATES, PAGE_STATES, createBus, createTracker };
