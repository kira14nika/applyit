/**
 * The AI layer: Gemini first, Groq as fallback. One small module, two transports, one
 * chain. Every caller (answers, resume extraction, matching) goes through askJson(), and
 * validation happens ABOVE this layer — no provider can bypass it.
 *
 *   ai = createAi({gemini: {apiKey, model}, groq: {apiKey, model}}, {fetchImpl, sleep, now, onCall, stateFile})
 *   await ai.askJson(prompt, {purpose})
 *     → {ok: true, json, provider, model, usage, retries, fallbackReason}
 *     | {ok: false, kind: 'daily-limit' | 'transient' | 'config', error}
 *   await ai.check()     → {gemini: {...}, groq: {...}} each provider tested on its own
 *
 * Policy (per request):
 *   Gemini: 503/5xx/timeout → one retry after ~3s, then Groq. 429 → wait if Retry-After
 *     < 10s and retry once, else Groq. DAILY quota exhausted → Gemini unavailable until
 *     midnight Pacific (persisted), everything goes straight to Groq.
 *   Groq: 429/503/5xx/timeout → up to 2 retries with backoff, honouring Retry-After /
 *     x-ratelimit-reset-* (a wait longer than 20s ends the attempt). Daily limit → Groq
 *     unavailable until its reported reset.
 *   Both: 400/401/403/404 are config errors — never retried; the provider is disabled for
 *     this process and the request falls through to the other one.
 *   No provider usable today because of daily limits → kind 'daily-limit' (the runner
 *   stops the run). Anything else failing → kind 'transient' (→ ai-error, FAILED).
 */
const fs = require('fs');
const path = require('path');

const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const STATE_FILE = path.join(__dirname, 'ai-state.json');
const CONFIG_STATUSES = [400, 401, 403, 404];

/** "2m59.56s" / "7.66s" / "1h2m" / "34s" / "12" (seconds) → ms; null if unparseable. */
function parseDuration(s) {
  if (s == null || s === '') return null;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(Number(str) * 1000);
  let ms = 0, hit = false;
  for (const [, n, u] of str.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    hit = true;
    ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[u];
  }
  return hit ? Math.round(ms) : null;
}

/** The next 00:00 in America/Los_Angeles (Gemini's daily quota reset), as a Date. */
function nextPacificMidnight(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 1, 0, 0, 0) - offset);
}

const header = (res, name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);

// ---------------------------------------------------------------- transports
// Each returns {ok, json, usage} or {ok:false, status, retryAfterMs, daily, dailyUntil, error, limits}

async function geminiCall({ apiKey, model }, prompt, { fetchImpl, timeoutMs, now }) {
  let res;
  try {
    res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: 0, error: /abort|timeout/i.test(String(e.name) + e.message) ? 'timeout' : `network: ${e.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = (data.error && data.error.details) || [];
    const msg = String((data.error && data.error.message) || '');
    const quotaIds = details.flatMap((d) => (d.violations || []).map((v) => String(v.quotaId || v.quotaMetric || '')));
    const retryInfo = details.find((d) => d.retryDelay);
    const daily = res.status === 429 && (quotaIds.some((q) => /per\s*day|perday/i.test(q)) || /per day|daily/i.test(msg));
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${msg.slice(0, 160)}`,
      retryAfterMs: parseDuration(header(res, 'retry-after')) ?? parseDuration(retryInfo && retryInfo.retryDelay),
      daily, dailyUntil: daily ? nextPacificMidnight(now()) : null };
  }
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
    .map((p) => p.text || '').join('');
  const u = data.usageMetadata || {};
  return { ok: true, text, usage: { prompt: u.promptTokenCount ?? null, completion: u.candidatesTokenCount ?? null, total: u.totalTokenCount ?? null } };
}

async function groqCall({ apiKey, model }, prompt, { fetchImpl, timeoutMs, now }) {
  let res;
  try {
    res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'You reply with a single JSON object and nothing else.' }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, status: 0, error: /abort|timeout/i.test(String(e.name) + e.message) ? 'timeout' : `network: ${e.message}` };
  }
  const limits = {
    remainingRequests: header(res, 'x-ratelimit-remaining-requests'), limitRequests: header(res, 'x-ratelimit-limit-requests'),
    remainingTokens: header(res, 'x-ratelimit-remaining-tokens'), limitTokens: header(res, 'x-ratelimit-limit-tokens'),
  };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String((data.error && data.error.message) || '');
    const daily = res.status === 429 && (/per day|\((RPD|TPD)\)/i.test(msg) || limits.remainingRequests === '0');
    const tryAgain = parseDuration((msg.match(/try again in ([\dhms.]+)/i) || [])[1]);
    const retryAfterMs = parseDuration(header(res, 'retry-after'))
      ?? parseDuration(header(res, 'x-ratelimit-reset-requests')) ?? parseDuration(header(res, 'x-ratelimit-reset-tokens')) ?? tryAgain;
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${msg.slice(0, 160)}`, retryAfterMs, limits,
      daily, dailyUntil: daily ? new Date(now().getTime() + (tryAgain ?? retryAfterMs ?? 3600000)) : null };
  }
  const u = data.usage || {};
  return { ok: true, text: String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''),
    usage: { prompt: u.prompt_tokens ?? null, completion: u.completion_tokens ?? null, total: u.total_tokens ?? null }, limits };
}

const parseJson = (text) => { try { return JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); } catch (e) { return undefined; } };

// ---------------------------------------------------------------- the chain

function createAi(config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => new Date());
  const onCall = deps.onCall || (() => {});
  const stateFile = deps.stateFile === undefined ? STATE_FILE : deps.stateFile; // null = memory only
  const timeoutMs = deps.timeoutMs || 25000;
  const providers = {
    gemini: { name: 'gemini', ...config.gemini, model: (config.gemini && config.gemini.model) || GEMINI_DEFAULT_MODEL, call: geminiCall },
    groq: { name: 'groq', ...config.groq, call: groqCall }, // no default model: GROQ_MODEL must be set
  };
  // availability: daily-limit markers persist across runs; config errors last for this process
  let state = {};
  if (stateFile) { try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { state = {}; } }
  const configBroken = {};
  const save = () => { if (stateFile) { try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch (e) { /* best effort */ } } };
  const dailyBlocked = (name) => state[name] && state[name].until && new Date(state[name].until) > now();
  const configured = (name) => !!(providers[name].apiKey && providers[name].model);
  const markDaily = (name, until, reason) => { state[name] = { until: until.toISOString(), reason }; save(); };

  /** One provider with its own retry policy. */
  async function tryProvider(name, prompt) {
    const p = providers[name];
    const isGemini = name === 'gemini';
    const maxRetries = isGemini ? 1 : 2;
    let retries = 0;
    for (;;) {
      const r = await p.call(p, prompt, { fetchImpl, timeoutMs, now });
      if (r.ok) {
        const json = parseJson(r.text);
        if (json === undefined) return { ok: false, retries, error: `${name} returned non-JSON`, fallThrough: true };
        return { ok: true, json, usage: r.usage, limits: r.limits, retries };
      }
      if (CONFIG_STATUSES.includes(r.status)) { configBroken[name] = r.error; return { ok: false, retries, error: r.error, config: true }; }
      if (r.daily) { markDaily(name, r.dailyUntil, r.error); return { ok: false, retries, error: r.error, daily: true }; }
      const transient = r.status === 0 || r.status === 429 || r.status >= 500;
      if (!transient || retries >= maxRetries) return { ok: false, retries, error: r.error };
      let wait;
      if (isGemini) {
        if (r.status === 429) { if (r.retryAfterMs == null || r.retryAfterMs >= 10000) return { ok: false, retries, error: r.error }; wait = r.retryAfterMs; }
        else wait = 3000;
      } else {
        wait = r.retryAfterMs ?? 2000 * 2 ** retries;
        if (wait > 20000) return { ok: false, retries, error: `${r.error} (retry in ${Math.round(wait / 1000)}s — too long)` };
      }
      retries++;
      await sleep(wait);
    }
  }

  async function askJson(prompt, meta = {}) {
    const attempts = [];
    let fallbackReason = null;
    for (const name of ['gemini', 'groq']) {
      if (!configured(name)) { attempts.push({ provider: name, skipped: 'not configured' }); continue; }
      if (configBroken[name]) { attempts.push({ provider: name, skipped: `config error: ${configBroken[name]}` }); continue; }
      if (dailyBlocked(name)) { attempts.push({ provider: name, skipped: `daily limit until ${state[name].until}` }); if (!fallbackReason) fallbackReason = `${name} daily limit`; continue; }
      const r = await tryProvider(name, prompt);
      attempts.push({ provider: name, ok: r.ok, retries: r.retries, error: r.error });
      if (r.ok) {
        const rec = { ok: true, json: r.json, provider: name, model: providers[name].model, usage: r.usage, limits: r.limits || null,
          retries: attempts.reduce((n, a) => n + (a.retries || 0), 0), fallbackReason };
        onCall({ purpose: meta.purpose || '', ok: true, provider: name, model: rec.model, usage: r.usage, retries: rec.retries, fallbackReason, attempts });
        return rec;
      }
      if (!fallbackReason) fallbackReason = `${name}: ${r.daily ? 'daily limit' : r.config ? 'config error' : r.error}`;
    }
    const usable = ['gemini', 'groq'].filter((n) => configured(n) && !configBroken[n]);
    const daily = usable.length > 0 && usable.every(dailyBlocked);
    const kind = daily ? 'daily-limit' : usable.length ? 'transient' : 'config';
    const error = kind === 'daily-limit' ? 'AI daily limits reached'
      : kind === 'config' ? `no usable AI provider (${attempts.map((a) => `${a.provider}: ${a.skipped || a.error}`).join('; ')})`
        : attempts.filter((a) => a.error).map((a) => `${a.provider}: ${a.error}`).join('; ') || 'AI unavailable';
    onCall({ purpose: meta.purpose || '', ok: false, provider: null, model: null, usage: null, fallbackReason, kind, error, attempts,
      retries: attempts.reduce((n, a) => n + (a.retries || 0), 0) });
    return { ok: false, kind, error };
  }

  /** Test each provider on its own (no fallback). Lists models on 404 / missing model. */
  async function check() {
    const out = {};
    for (const name of ['gemini', 'groq']) {
      const p = providers[name];
      if (!p.apiKey) { out[name] = { ok: false, model: p.model || null, reason: `${name === 'gemini' ? 'GEMINI_KEY' : 'GROQ_API_KEY'} is not set` }; continue; }
      if (!p.model) { out[name] = { ok: false, model: null, reason: 'GROQ_MODEL is not set', models: await listModels(name) }; continue; }
      if (dailyBlocked(name)) { out[name] = { ok: false, model: p.model, reason: `daily limit reached — unavailable until ${state[name].until}` }; continue; }
      const r = await p.call(p, 'Connectivity check. Reply with exactly this JSON and nothing else: {"ok":true}', { fetchImpl, timeoutMs: 20000, now });
      const json = r.ok ? parseJson(r.text) : undefined;
      const ok = !!(json && json.ok === true);
      out[name] = { ok, model: p.model, reason: ok ? 'responded' : r.ok ? 'responded without the expected JSON' : r.error,
        limits: r.limits || (name === 'gemini' ? 'not reported by Gemini' : null) };
      if (r.status === 404) out[name].models = await listModels(name);
    }
    return out;
  }

  async function listModels(name) {
    const p = providers[name];
    try {
      if (name === 'gemini') {
        const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=300', { headers: { 'x-goog-api-key': p.apiKey } });
        const j = await r.json();
        return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace('models/', ''));
      }
      const r = await fetchImpl('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${p.apiKey}` } });
      const j = await r.json();
      return (j.data || []).filter((m) => m.active !== false).map((m) => m.id);
    } catch (e) { return [`(could not list models: ${e.message})`]; }
  }

  return {
    askJson, check, listModels,
    status: () => Object.fromEntries(['gemini', 'groq'].map((n) => [n, { configured: configured(n), model: providers[n].model || null,
      dailyUntil: dailyBlocked(n) ? state[n].until : null, configError: configBroken[n] || null }])),
  };
}

/** Provider config from config.js (.env). */
function aiConfig(cfg) {
  return { gemini: { apiKey: cfg.geminiKey, model: cfg.geminiModel || GEMINI_DEFAULT_MODEL }, groq: { apiKey: cfg.groqKey, model: cfg.groqModel } };
}

module.exports = { createAi, aiConfig, parseDuration, nextPacificMidnight, GEMINI_DEFAULT_MODEL, STATE_FILE };
