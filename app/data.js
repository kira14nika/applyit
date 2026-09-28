/**
 * Read-only views over the persistent files for the desktop app. Pure functions of
 * (ledger, history, deferred) so they are unit-tested without Electron.
 *
 * Status comes ONLY from the ledger (latest line per job): APPLIED, ALREADY_APPLIED
 * (APPLIED/already-applied — never counted), SKIPPED, FAILED. Deferred company-site
 * jobs come from the deferred list. History only adds detail.
 */
const categoryOf = (r) => (r.status === 'APPLIED' && r.reason === 'already-applied' ? 'ALREADY_APPLIED' : r.status);

const latestBy = (records, key) => {
  const m = new Map();
  for (const r of records) {
    const prev = m.get(r[key]);
    if (!prev || String(r.ts) >= String(prev.ts)) m.set(r[key], r);
  }
  return m;
};

/** History job records for a job, newest first; real (non-DRY) runs preferred for details. */
function historyFor(history, jobId) {
  return history.filter((h) => h.type === 'job' && h.jobId === jobId).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}
const detailsFrom = (hs) => hs.find((h) => h.mode !== 'DRY') || hs[0] || {};
/** Walk-in date/venue from the job page details or the skip record; null when not a walk-in. */
const walkInOf = (d) => d.walkIn || (d.outcome && d.outcome.applyRoute && d.outcome.applyRoute.walkIn) || null;

function buildApplications({ ledger = [], history = [], deferred = [] }) {
  const rows = [];
  for (const r of latestBy(ledger, 'jobId').values()) {
    const d = detailsFrom(historyFor(history, r.jobId));
    rows.push({
      jobId: r.jobId, ts: r.ts, day: r.day, platform: 'Naukri', category: categoryOf(r), status: r.status,
      reason: r.reason, title: r.title || d.title || '', company: r.company || d.company || '',
      location: d.location || '', url: r.url, match: d.match ? d.match.score : null,
      walkIn: walkInOf(d),
    });
  }
  const inLedger = new Set(rows.map((r) => r.jobId));
  for (const r of latestBy(deferred, 'jobId').values()) {
    if (inLedger.has(r.jobId)) continue;
    const d = detailsFrom(historyFor(history, r.jobId));
    rows.push({ jobId: r.jobId, ts: r.ts, day: r.day, platform: 'Naukri', category: 'DEFERRED', status: 'DEFERRED',
      reason: r.reason, title: r.title || d.title || '', company: r.company || d.company || '', location: d.location || '',
      url: r.url, match: d.match ? d.match.score : null });
  }
  return rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

function jobDetails({ ledger = [], history = [], deferred = [] }, jobId) {
  const records = ledger.filter((r) => r.jobId === jobId).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const hs = historyFor(history, jobId);
  const latest = records[records.length - 1];
  return {
    jobId, category: latest ? categoryOf(latest) : (deferred.some((d) => d.jobId === jobId) ? 'DEFERRED' : null),
    ledger: records, deferred: deferred.filter((d) => d.jobId === jobId), details: detailsFrom(hs), history: hs,
  };
}

/** Counts per category over ledger lines of a given day (APPLIED counts only new, verified ones). */
function dayCounts(ledger, day) {
  const c = { APPLIED: 0, ALREADY_APPLIED: 0, SKIPPED: 0, FAILED: 0 };
  for (const r of ledger) if (r.day === day) c[categoryOf(r)]++;
  return c;
}

function buildReports({ ledger = [], history = [], deferred = [] }) {
  const days = [...new Set(ledger.map((r) => r.day))].sort().reverse();
  const daily = days.map((day) => ({ day, ...dayCounts(ledger, day), DEFERRED: deferred.filter((d) => d.day === day).length }));
  const outcomes = { APPLIED: 0, ALREADY_APPLIED: 0, SKIPPED: 0, FAILED: 0, DEFERRED: deferred.length };
  for (const r of latestBy(ledger, 'jobId').values()) outcomes[categoryOf(r)]++;
  // intervention categories: from the history detail, else the ledger reason "human-needed: <cat>"
  const interventions = {};
  for (const r of ledger.filter((x) => x.status === 'SKIPPED')) {
    const h = historyFor(history, r.jobId).find((x) => x.outcome && x.outcome.status === 'SKIPPED');
    const cat = h?.outcome?.intervention?.category || (String(r.reason).match(/human-needed:\s*(\S+)/) || [])[1] || 'unspecified';
    interventions[cat] = (interventions[cat] || 0) + 1;
  }
  const failures = {};
  for (const r of ledger.filter((x) => x.status === 'FAILED')) {
    const k = String(r.reason).replace(/\s*\(.*$/, '').slice(0, 60) || 'unspecified';
    failures[k] = (failures[k] || 0) + 1;
  }
  const runs = {};
  for (const h of history.filter((x) => x.type === 'job')) {
    const r = (runs[h.runId] ||= { runId: h.runId, mode: h.mode, first: h.ts, last: h.ts, jobs: 0, outcomes: {} });
    r.jobs++;
    if (String(h.ts) < String(r.first)) r.first = h.ts;
    if (String(h.ts) > String(r.last)) r.last = h.ts;
    const s = h.outcome?.status || '?';
    r.outcomes[s] = (r.outcomes[s] || 0) + 1;
  }
  const matched = history.filter((h) => h.type === 'job' && h.match && typeof h.match.score === 'number');
  const matching = matched.length
    ? { jobs: matched.length, avgScore: Math.round(matched.reduce((s, h) => s + h.match.score, 0) / matched.length) }
    : { jobs: 0, avgScore: null };
  return { daily, outcomes, interventions, failures, runs: Object.values(runs).sort((a, b) => String(b.first).localeCompare(String(a.first))), matching };
}

/** AI calls made today (local day), per provider, from the history's ai-call records. */
function aiCallsToday(history = [], now = new Date()) {
  const key = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = key(now);
  const out = { gemini: 0, groq: 0, failed: 0, tokens: { gemini: 0, groq: 0 } };
  for (const h of history) {
    if (h.type !== 'ai-call' || !h.ts || key(new Date(h.ts)) !== today) continue;
    if (!h.ok || !h.provider) { out.failed++; continue; }
    out[h.provider] = (out[h.provider] || 0) + 1;
    if (h.usage && typeof h.usage.total === 'number') out.tokens[h.provider] = (out.tokens[h.provider] || 0) + h.usage.total;
  }
  return out;
}

module.exports = { categoryOf, buildApplications, jobDetails, buildReports, dayCounts, aiCallsToday };
