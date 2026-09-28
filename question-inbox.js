/**
 * "Needs your answer" inbox.
 *
 * When a job is SKIPPED because a question could not be answered truthfully
 * (missing-info / unanswerable-question), the question is shown to the user once —
 * identical and near-identical questions grouped together. The user either answers it
 * (saved in profile.json `answeredByYou`, source "answered by you") or chooses
 * "Don't answer this" (`dontAnswer`: such jobs keep being skipped, without an AI call).
 *
 * Only FUTURE jobs use these. Jobs already SKIPPED stay SKIPPED — nothing here touches
 * the ledger. Saved answers go through the answer engine's normal validation (options
 * verbatim, numeric), exactly like every other profile fact.
 */
const INBOX_CATEGORIES = ['missing-info', 'unanswerable-question'];
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'be', 'do', 'does', 'did', 'you', 'your', 'yours', 'what', 's',
  'please', 'kindly', 'tell', 'us', 'me', 'of', 'in', 'on', 'for', 'to', 'with', 'and', 'or', 'have', 'has', 'any', 'can', 'will', 'would']);

const normalize = (q) => String(q || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (q) => new Set(normalize(q).split(' ').filter((t) => t && !STOP.has(t)));
/** Same question in different words/punctuation/case: token-set Jaccard ≥ 0.8. */
function similar(a, b) {
  if (normalize(a) === normalize(b)) return true;
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter) >= 0.8;
}
/** Option questions only group with the same set of options. */
const optionSig = (options) => (options || []).map(normalize).filter(Boolean).sort().join('|');
const same = (a, b) => optionSig(a.options) === optionSig(b.options) && similar(a.question, b.question);
const keyOf = (question, options) => `${normalize(question)}#${optionSig(options)}`;

/** A saved answer or a "don't answer" choice matching this question, or null. */
function findSaved(question, options, saved = {}) {
  const q = { question, options };
  const dont = (saved.dontAnswer || []).find((d) => same(d, q));
  if (dont) return { type: 'dont', entry: dont };
  const ans = (saved.answeredByYou || []).find((a) => same(a, q));
  return ans ? { type: 'answer', entry: ans } : null;
}

/**
 * Open inbox groups from history job records. Each group: {key, question, options,
 * categories, jobs: [{jobId, title, company, ts}], lastSeen}. Groups the user already
 * answered or declined are not open.
 */
function buildInbox(history = [], saved = {}) {
  const groups = [];
  for (const h of history) {
    if (h.type !== 'job' || !h.outcome || h.outcome.status !== 'SKIPPED') continue;
    const iv = h.outcome.intervention;
    if (!iv || !INBOX_CATEGORIES.includes(iv.category) || !String(iv.question || '').trim()) continue;
    const q = { question: iv.question.trim(), options: Array.isArray(iv.options) ? iv.options : [] };
    if (findSaved(q.question, q.options, saved)) continue;
    let g = groups.find((x) => same(x, q));
    if (!g) groups.push(g = { key: keyOf(q.question, q.options), question: q.question, options: q.options, categories: [], missing: [], jobs: [], lastSeen: h.ts });
    if (!g.categories.includes(iv.category)) g.categories.push(iv.category);
    if (iv.missing && !g.missing.includes(iv.missing)) g.missing.push(iv.missing);
    if (!g.jobs.some((j) => j.jobId === h.jobId)) g.jobs.push({ jobId: h.jobId, title: h.title || '', company: h.company || '', ts: h.ts });
    if (String(h.ts) > String(g.lastSeen)) g.lastSeen = h.ts;
  }
  return groups.sort((a, b) => b.jobs.length - a.jobs.length || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

/**
 * Record the user's answer to a group → updated profile (caller saves it). Option
 * questions must be answered with one of their options, verbatim.
 */
function saveAnswer(profile, group, answer) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) throw new Error('an answer is required');
  if (a.length > 500) throw new Error('answer too long (500 characters max)');
  if (group.options && group.options.length && !group.options.includes(a)) throw new Error('choose one of the options');
  const p = { ...(profile || {}) };
  p.answeredByYou = [...(p.answeredByYou || []).filter((x) => !same(x, group)),
    { key: group.key, question: group.question, options: group.options || [], answer: a, source: 'answered by you', savedAt: new Date().toISOString() }];
  p.dontAnswer = (p.dontAnswer || []).filter((x) => !same(x, group));
  return p;
}

/** "Don't answer this": jobs asking it keep being skipped. */
function dontAnswer(profile, group) {
  const p = { ...(profile || {}) };
  p.dontAnswer = [...(p.dontAnswer || []).filter((x) => !same(x, group)),
    { key: group.key, question: group.question, options: group.options || [], savedAt: new Date().toISOString() }];
  p.answeredByYou = (p.answeredByYou || []).filter((x) => !same(x, group));
  return p;
}

/** Undo a saved answer or a "don't answer" choice (the question may return to the inbox). */
function forget(profile, key) {
  const p = { ...(profile || {}) };
  p.answeredByYou = (p.answeredByYou || []).filter((x) => x.key !== key);
  p.dontAnswer = (p.dontAnswer || []).filter((x) => x.key !== key);
  return p;
}

module.exports = { INBOX_CATEGORIES, normalize, similar, findSaved, buildInbox, saveAnswer, dontAnswer, forget, keyOf };
