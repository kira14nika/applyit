/** node --test ai-providers.test.js — Gemini → Groq chain with mocked transports. No network. */
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAi, parseDuration, nextPacificMidnight } = require('./ai-providers');
const E = require('./answer-engine');

// ---- mock transport: queues of responses per provider --------------------------------
const res = ({ status = 200, body = {}, headers = {} }) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (n) => headers[n.toLowerCase()] ?? null },
});
const gOk = (obj) => ({ body: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } } });
const qOk = (obj, headers = {}) => ({ body: { choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } }, headers });
const gDaily = { status: 429, body: { error: { code: 429, message: 'You exceeded your current quota.', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '40s' }] } } };
const qDaily = { status: 429, body: { error: { message: 'Rate limit reached for model `m` on requests per day (RPD): Limit 1000, Used 1000. Please try again in 1h2m3s.' } } };
function transport(queues) {
  const calls = { gemini: 0, groq: 0 };
  const f = async (url, init) => {
    const p = /googleapis/.test(url) ? 'gemini' : 'groq';
    calls[p]++;
    const next = (queues[p] || []).shift();
    if (!next) throw new Error(`unexpected ${p} call`);
    if (next instanceof Error) throw next;
    return res(next);
  };
  f.calls = calls;
  return f;
}
const waits = [];
const mk = (queues, { groq = true, stateFile = null, now } = {}) => {
  const fetchImpl = transport(queues);
  const records = [];
  const ai = createAi({ gemini: { apiKey: 'g', model: 'gem-m' }, groq: groq ? { apiKey: 'q', model: 'groq-m' } : {} },
    { fetchImpl, sleep: async (ms) => { waits.push(ms); }, onCall: (r) => records.push(r), stateFile, now });
  return { ai, fetchImpl, records };
};
const OK = { status: 'answered', answer: 'SQL dashboards for sales', evidence: 'skills' };

test('Gemini ok → answered by Gemini; tokens recorded', async () => {
  const { ai, fetchImpl, records } = mk({ gemini: [gOk({ x: 1 })] });
  const r = await ai.askJson('p', { purpose: 'answer' });
  assert.deepStrictEqual([r.ok, r.provider, r.model, r.retries, r.fallbackReason], [true, 'gemini', 'gem-m', 0, null]);
  assert.deepStrictEqual(r.usage, { prompt: 10, completion: 5, total: 15, reasoning: null });
  assert.deepStrictEqual(fetchImpl.calls, { gemini: 1, groq: 0 });
  assert.strictEqual(records[0].purpose, 'answer');
  assert.strictEqual(records[0].provider, 'gemini');
});

test('Gemini 503 → one retry after ~3s → ok', async () => {
  waits.length = 0;
  const { ai, fetchImpl } = mk({ gemini: [{ status: 503, body: { error: { message: 'overloaded' } } }, gOk({ x: 1 })] });
  const r = await ai.askJson('p');
  assert.strictEqual(r.provider, 'gemini');
  assert.strictEqual(r.retries, 1);
  assert.deepStrictEqual(waits, [3000]);
  assert.deepStrictEqual(fetchImpl.calls, { gemini: 2, groq: 0 });
});

test('Gemini 503 twice → Groq ok, with the fallback reason recorded', async () => {
  const { ai, fetchImpl, records } = mk({ gemini: [{ status: 503 }, { status: 503 }], groq: [qOk({ x: 1 })] });
  const r = await ai.askJson('p');
  assert.deepStrictEqual([r.ok, r.provider, r.model], [true, 'groq', 'groq-m']);
  assert.match(r.fallbackReason, /^gemini: HTTP 503/);
  assert.deepStrictEqual(r.usage, { prompt: 20, completion: 6, total: 26, reasoning: null });
  assert.deepStrictEqual(fetchImpl.calls, { gemini: 2, groq: 1 });
  assert.strictEqual(records[0].retries, 1);
});

test('Gemini timeout counts as transient (retry, then Groq)', async () => {
  const t = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { ai, fetchImpl } = mk({ gemini: [t, t], groq: [qOk({ x: 1 })] });
  assert.strictEqual((await ai.askJson('p')).provider, 'groq');
  assert.deepStrictEqual(fetchImpl.calls, { gemini: 2, groq: 1 });
});

test('Gemini 429: short Retry-After → wait and retry; long → straight to Groq', async () => {
  waits.length = 0;
  const short = mk({ gemini: [{ status: 429, headers: { 'retry-after': '2' } }, gOk({ x: 1 })] });
  assert.strictEqual((await short.ai.askJson('p')).provider, 'gemini');
  assert.deepStrictEqual(waits, [2000]);
  const long = mk({ gemini: [{ status: 429, body: { error: { message: 'slow down', details: [{ retryDelay: '30s' }] } } }], groq: [qOk({ x: 1 })] });
  assert.strictEqual((await long.ai.askJson('p')).provider, 'groq');
  assert.deepStrictEqual(long.fetchImpl.calls, { gemini: 1, groq: 1 });
});

test('Gemini DAILY quota → Groq for the rest of the day, persisted across runs', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-')), 'ai-state.json');
  const now = () => new Date('2026-09-28T10:00:00Z'); // 03:00 in Los Angeles (PDT)
  const a = mk({ gemini: [gDaily], groq: [qOk({ n: 1 }), qOk({ n: 2 })] }, { stateFile, now });
  const r1 = await a.ai.askJson('p');
  assert.strictEqual(r1.provider, 'groq');
  const r2 = await a.ai.askJson('p');
  assert.strictEqual(r2.provider, 'groq');
  assert.match(r2.fallbackReason, /gemini daily limit/);
  assert.deepStrictEqual(a.fetchImpl.calls, { gemini: 1, groq: 2 }, 'Gemini not called again');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(saved.gemini.until, '2026-09-29T07:00:00.000Z', 'until midnight Pacific');
  // a new process (next run) the same day also goes straight to Groq
  const b = mk({ groq: [qOk({ n: 3 })] }, { stateFile, now });
  assert.strictEqual((await b.ai.askJson('p')).provider, 'groq');
  assert.deepStrictEqual(b.fetchImpl.calls, { gemini: 0, groq: 1 });
  // after the reset Gemini is tried again
  const c = mk({ gemini: [gOk({ n: 4 })] }, { stateFile, now: () => new Date('2026-09-29T07:00:01Z') });
  assert.strictEqual((await c.ai.askJson('p')).provider, 'gemini');
});

test('both providers daily-exhausted → daily-limit (the run stops), not a transient error', async () => {
  const { ai } = mk({ gemini: [gDaily], groq: [qDaily] });
  const r = await ai.askJson('p');
  assert.deepStrictEqual([r.ok, r.kind, r.error], [false, 'daily-limit', 'AI daily limits reached']);
  const again = await ai.askJson('p'); // nothing is called any more
  assert.strictEqual(again.kind, 'daily-limit');
  const a = await E.answer({ question: 'Describe your Power BI work' }, { facts: { skills: 'Power BI' }, ai });
  assert.deepStrictEqual([a.status, a.category], ['unknown', 'ai-daily-limit']);
});

test('the runner stops cleanly on ai-daily-limit; the job is a retryable FAILED outside the questionnaire cap', () => {
  const runner = fs.readFileSync(path.join(__dirname, 'auto-apply-runner.js'), 'utf8');
  assert.ok(runner.includes("if (res.category === 'ai-daily-limit') control.stop('AI daily limits reached');"));
  assert.ok(runner.includes("const endReason = stopRequested ? (stopReason || 'stopped by the user')"));
  const page = fs.readFileSync(path.join(__dirname, 'naukri-auto-apply.js'), 'utf8');
  assert.ok(page.includes("if (res.category === 'ai-daily-limit') { why = `ai-daily-limit: ${res.missing}`; return false; }"));
  assert.ok(!page.includes('questionnaire-stage: ai-daily-limit'), 'quota exhaustion never counts toward the questionnaire cap');
});

test('both transiently failing → transient (→ ai-error, FAILED)', async () => {
  const { ai } = mk({ gemini: [{ status: 500 }, { status: 500 }], groq: [{ status: 503 }, { status: 503 }, { status: 503 }] });
  const r = await ai.askJson('p');
  assert.deepStrictEqual([r.ok, r.kind], [false, 'transient']);
});

test('404 (and 400/401/403) are never retried: config error, falls through to Groq', async () => {
  waits.length = 0;
  const { ai, fetchImpl } = mk({ gemini: [{ status: 404, body: { error: { message: 'models/gem-m is not found' } } }], groq: [qOk({ x: 1 }), qOk({ x: 2 })] });
  const r = await ai.askJson('p');
  assert.strictEqual(r.provider, 'groq');
  assert.match(r.fallbackReason, /gemini: config error/);
  await ai.askJson('p');
  assert.deepStrictEqual(fetchImpl.calls, { gemini: 1, groq: 2 }, 'a broken provider is not retried, not even on the next request');
  assert.deepStrictEqual(waits, []);
  const only = mk({ gemini: [{ status: 401 }] }, { groq: false });
  const r2 = await only.ai.askJson('p');
  assert.deepStrictEqual([r2.kind, only.fetchImpl.calls.gemini], ['config', 1]);
  const groq403 = mk({ gemini: [{ status: 503 }, { status: 503 }], groq: [{ status: 403 }] });
  assert.strictEqual((await groq403.ai.askJson('p')).ok, false);
  assert.strictEqual(groq403.fetchImpl.calls.groq, 1);
});

test('Groq 429/503 retried up to 2 times honouring Retry-After / x-ratelimit headers', async () => {
  waits.length = 0;
  const { ai, fetchImpl } = mk({ gemini: [{ status: 503 }, { status: 503 }],
    groq: [{ status: 429, headers: { 'retry-after': '1' } }, { status: 503, headers: { 'x-ratelimit-reset-requests': '2.5s' } }, qOk({ x: 1 })] });
  const r = await ai.askJson('p');
  assert.strictEqual(r.provider, 'groq');
  assert.deepStrictEqual(waits, [3000, 1000, 2500]);
  assert.strictEqual(fetchImpl.calls.groq, 3);
  const giveUp = mk({ gemini: [{ status: 503 }, { status: 503 }], groq: [{ status: 503 }, { status: 503 }, { status: 503 }] });
  assert.strictEqual((await giveUp.ai.askJson('p')).kind, 'transient');
  assert.strictEqual(giveUp.fetchImpl.calls.groq, 3, 'first try + 2 retries');
});

test('Groq daily limit → Groq unavailable until its reset', async () => {
  const now = () => new Date('2026-09-28T10:00:00Z');
  const { ai } = mk({ gemini: [{ status: 503 }, { status: 503 }, gOk({ x: 1 })], groq: [qDaily] }, { now });
  assert.strictEqual((await ai.askJson('p')).kind, 'transient', 'Gemini was only transiently down');
  const st = ai.status();
  assert.strictEqual(st.groq.dailyUntil, new Date(now().getTime() + 3723000).toISOString(), 'reset from "try again in 1h2m3s"');
  assert.strictEqual((await ai.askJson('p')).provider, 'gemini');
});

test('invalid option from Groq is rejected by the same validation', async () => {
  const { ai } = mk({ gemini: [{ status: 503 }, { status: 503 }], groq: [qOk({ status: 'answered', answer: 'Yes please', evidence: 'x' })] });
  const r = await E.answer({ question: 'Willing to relocate?', options: ['Yes', 'No'] }, { facts: { skills: 'SQL' }, ai });
  assert.strictEqual(r.status, 'unknown');
  assert.match(r.missing, /not one of the options/);
});

test('numeric and evidence rules apply to Groq too', async () => {
  const { ai } = mk({ gemini: [gDaily], groq: [qOk({ status: 'answered', answer: 'about 3', evidence: 'x' }), qOk({ status: 'answered', answer: 'Yes', evidence: '' })] });
  assert.strictEqual((await E.answer({ question: 'Years of SQL?', numeric: true }, { facts: { skills: 'SQL' }, ai })).status, 'unknown');
  assert.strictEqual((await E.answer({ question: 'Do you know SQL?' }, { facts: { skills: 'SQL' }, ai })).status, 'unknown');
});

test('unknown from either provider → the SKIPPED path (missing-info / unanswerable), unchanged', async () => {
  const g = mk({ gemini: [gOk({ status: 'unknown', missing: 'team size history' })] });
  const a = await E.answer({ question: 'How many people have you managed?' }, { facts: { skills: 'SQL' }, ai: g.ai });
  assert.deepStrictEqual([a.status, a.category], ['unknown', 'missing-info']);
  const q = mk({ gemini: [gDaily], groq: [qOk({ status: 'unknown' })] });
  const b = await E.answer({ question: 'Why this company?' }, { facts: { skills: 'SQL' }, ai: q.ai });
  assert.deepStrictEqual([b.status, b.category], ['unknown', 'unanswerable-question']);
  const ok = mk({ gemini: [gOk(OK)] });
  const c = await E.answer({ question: 'Describe your SQL work' }, { facts: { skills: 'SQL' }, ai: ok.ai });
  assert.deepStrictEqual([c.status, c.ai], ['answered', { provider: 'gemini', model: 'gem-m' }]);
});

test('check(): each provider on its own; lists Groq models when GROQ_MODEL is missing', async () => {
  const fetchImpl = async (url) => {
    if (/googleapis.*generateContent/.test(url)) return res(gOk({ ok: true }));
    if (/groq.com\/openai\/v1\/models/.test(url)) return res({ body: { data: [{ id: 'model-a', active: true }, { id: 'model-b', active: false }] } });
    throw new Error('unexpected ' + url);
  };
  const ai = createAi({ gemini: { apiKey: 'g', model: 'gem-m' }, groq: { apiKey: 'q', model: '' } }, { fetchImpl, stateFile: null });
  const r = await ai.check();
  assert.deepStrictEqual([r.gemini.ok, r.gemini.model, r.gemini.limits], [true, 'gem-m', 'not reported by Gemini']);
  assert.deepStrictEqual([r.groq.ok, r.groq.reason, r.groq.models], [false, 'GROQ_MODEL is not set', ['model-a']]);
});

// ---- model listing: a failure is an error with its reason, never an empty list ----------
const { formatCheck, parseJson } = require('./ai-providers');
const lister = (response) => createAi({ gemini: { apiKey: 'g', model: 'gem-m' }, groq: { apiKey: 'bad', model: '' } },
  { stateFile: null, fetchImpl: async (url) => {
    if (/generateContent/.test(url)) return res(gOk({ ok: true }));
    if (response instanceof Error) throw response;
    return res(response);
  } });

test('listModels: 401 / non-JSON / network / odd shape are errors with the reason (the old code returned [])', async () => {
  const e401 = await lister({ status: 401, body: { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } } }).listModels('groq');
  assert.deepStrictEqual(e401, { ok: false, error: 'HTTP 401: Invalid API Key' });
  const html = await lister({ status: 403, body: '<html><body>error code: 1010</body></html>' }).listModels('groq');
  assert.strictEqual(html.ok, false);
  assert.match(html.error, /^HTTP 403: non-JSON response: <html>/);
  const net = await lister(new Error('getaddrinfo ENOTFOUND api.groq.com')).listModels('groq');
  assert.deepStrictEqual(net, { ok: false, error: 'request failed: getaddrinfo ENOTFOUND api.groq.com' });
  const odd = await lister({ status: 200, body: { object: 'list' } }).listModels('groq');
  assert.deepStrictEqual(odd, { ok: false, error: 'HTTP 200: unexpected response (no data array)' });
  const good = await lister({ status: 200, body: { object: 'list', data: [{ id: 'openai/gpt-oss-120b', active: true }, { id: 'old', active: false }, { id: 'x' }] } }).listModels('groq');
  assert.deepStrictEqual(good, { ok: true, models: ['openai/gpt-oss-120b', 'x'] });
});

test('--check prints the listing error instead of an empty model list', async () => {
  const r = await lister({ status: 401, body: { error: { message: 'Invalid API Key' } } }).check();
  assert.deepStrictEqual([r.groq.ok, r.groq.reason, r.groq.models, r.groq.listError], [false, 'GROQ_MODEL is not set', undefined, 'HTTP 401: Invalid API Key']);
  const { lines, working } = formatCheck(r);
  assert.ok(lines.includes('       model listing FAILED: HTTP 401: Invalid API Key'), lines.join('\n'));
  assert.ok(!lines.some((l) => /models this key can use \(0\)/.test(l)));
  assert.strictEqual(working, 1);
  const ok = formatCheck({ groq: { ok: false, model: null, reason: 'GROQ_MODEL is not set', models: ['openai/gpt-oss-120b'] } });
  assert.ok(ok.lines.includes('       models this key can use (1): openai/gpt-oss-120b'));
});

// ---- reasoning models: thinking must never break or steer the JSON parse ----------------
test('parseJson: clean JSON, fences, inline <think>, surrounding prose (last object wins), no JSON', () => {
  assert.deepStrictEqual(parseJson('{"status":"answered","answer":"Yes","evidence":"x"}'), { status: 'answered', answer: 'Yes', evidence: 'x' });
  assert.deepStrictEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseJson('<think>Maybe {"status":"unknown"}? Let me check {"a": 17}.</think>\n{"status":"answered","answer":"No"}'),
    { status: 'answered', answer: 'No' });
  assert.deepStrictEqual(parseJson('Schema: {"status":"answered"|"unknown"}. Draft: {"answer":"draft"}. Final:\n{"answer":"final","note":"a } in a string"}'),
    { answer: 'final', note: 'a } in a string' }, 'invalid schema braces skipped, last complete object used');
  assert.strictEqual(parseJson('I cannot answer that.'), undefined);
  assert.strictEqual(parseJson(''), undefined);
  assert.strictEqual(parseJson('[1,2]'), undefined, 'an array is not an answer object');
});

test('Groq gpt-oss: reasoning in message.reasoning is ignored — the answer comes from content', async () => {
  const body = {
    choices: [{ message: { role: 'assistant',
      reasoning: 'The user wants JSON. Wrong idea first: {"status":"answered","answer":"No","evidence":"guess"}. Actually 17 is prime.',
      content: '{"status":"answered","answer":"Yes","evidence":"skills"}' } }],
    usage: { prompt_tokens: 143, completion_tokens: 196, total_tokens: 339, completion_tokens_details: { reasoning_tokens: 154 } },
  };
  const { ai } = mk({ gemini: [gDaily], groq: [{ body }] });
  const r = await ai.askJson('p');
  assert.deepStrictEqual(r.json, { status: 'answered', answer: 'Yes', evidence: 'skills' });
  assert.deepStrictEqual(r.usage, { prompt: 143, completion: 196, total: 339, reasoning: 154 });
  const inline = mk({ gemini: [gDaily], groq: [{ body: { choices: [{ message: { content: '<think>{"answer":"No"}</think>{"status":"answered","answer":"Yes","evidence":"skills"}' } }] } }] });
  assert.strictEqual((await inline.ai.askJson('p')).json.answer, 'Yes');
});

test('Gemini thought parts are ignored — only answer parts are parsed', async () => {
  const body = { candidates: [{ content: { parts: [{ thought: true, text: 'thinking {"answer":"No"}' }, { text: '{"answer":"Yes"}' }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 50, thoughtsTokenCount: 33 } };
  const { ai } = mk({ gemini: [{ body }] });
  const r = await ai.askJson('p');
  assert.deepStrictEqual([r.json, r.usage.reasoning], [{ answer: 'Yes' }, 33]);
});

test('duration and Pacific-midnight helpers', () => {
  assert.strictEqual(parseDuration('2m59.56s'), 179560);
  assert.strictEqual(parseDuration('7.66s'), 7660);
  assert.strictEqual(parseDuration('1h2m3s'), 3723000);
  assert.strictEqual(parseDuration('12'), 12000);
  assert.strictEqual(parseDuration('soon'), null);
  assert.strictEqual(nextPacificMidnight(new Date('2026-09-28T10:00:00Z')).toISOString(), '2026-09-29T07:00:00.000Z'); // PDT
  assert.strictEqual(nextPacificMidnight(new Date('2026-12-01T10:00:00Z')).toISOString(), '2026-12-02T08:00:00.000Z'); // PST
});

test('only the facts a question needs are sent to the AI', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return res(gOk({ status: 'unknown', missing: 'x' })); };
  const ai = createAi({ gemini: { apiKey: 'g', model: 'm' } }, { fetchImpl, stateFile: null });
  const facts = { skills: 'SQL, Power BI', email: 'me@x.com', phone: '999', currentCTC_lakhs: '6', noticePeriod: '30 days', gender: 'F', location: 'Pune' };
  await E.answer({ question: 'Describe your Power BI dashboards' }, { facts, ai });
  const sent = calls[0].contents[0].parts[0].text;
  assert.ok(sent.includes('Power BI'));
  for (const x of ['me@x.com', '999', '"6"', '30 days', '"F"', 'Pune']) assert.ok(!sent.includes(x), `must not send ${x}`);
  await E.answer({ question: 'What pay package would you accept, and how soon could you start?' }, { facts, ai });
  const sent2 = calls[1].contents[0].parts[0].text;
  assert.ok(sent2.includes('30 days') && sent2.includes('currentCTC_lakhs'));
  assert.ok(!sent2.includes('me@x.com'));
});
