# ApplyIt — build progress

Product plan: [PLAN.md](PLAN.md) (written as "JobPilot"; the product is now **ApplyIt**).

Rules that hold across every phase: `naukri-ledger.jsonl` is the only quota authority;
only a Node reload-verified NEW application counts; 10/run + 50/day; APPLIED / SKIPPED /
FAILED keep their meanings; already-applied never counts; pagination/resume untouched.
No phase ran a mode that can click Apply — dry runs only.

## Phase 1 — Safety rails ✅

| What | Where |
|---|---|
| Modes: `DRY` (default) · `TEST --test --only=<id\|url,…>` · `LIVE --live --confirm-live` (or type `LIVE` at a TTY prompt; no TTY + no flag = refuse) | `safety.js` `parseMode`, runner start |
| LIVE banner "LIVE — REAL APPLICATIONS WILL BE SUBMITTED" | runner start |
| Node-side click gate `__aaMayClick(jobId)`: DRY denies, TEST allow-list only, LIVE only when confirmed. The page never clicks if the binding is missing, throws, or returns anything but `true` | `safety.js` `mayClick`, runner `onMayClick`, `naukri-auto-apply.js` before the click sequence |
| TEST: allow-listed URLs are opened directly; target = min(ledger target, allow-list size); the run ends when every allow-listed job has a final outcome; ledger is written only for allow-listed jobs | runner `markTested`, page `directJobs` |
| Global error handlers now ignore only known navigation/stealth races; other rejections are logged as `ERROR` (counted in the final summary), other exceptions are `FATAL` and exit | `safety.js` `isBenignRace`, runner top |
| Company-site jobs parked in `naukri-deferred.jsonl` (not the ledger, not SKIPPED) in non-DRY modes, excluded from later runs | `naukri-deferred.js`, runner console handler |
| Shared append-only JSONL helper (ledger now uses it; behaviour unchanged) | `jsonl.js` |
| `--test` refused for indeed/wellfound (their scripts have no gate) | runner |

Tests: `safety.test.js` (DRY denies, TEST allow-list, LIVE only when confirmed, bad
combinations, benign-race filter, gate-before-click source check, deferred list).

Not verified: TEST and LIVE modes were never run (hard rule). `--scheduled` hourly
tasks (`setup-schedule.ps1`) now also need `--confirm-live` to run live — scheduling is
out of scope and was not changed.

## Phase 2 — Truthful answers ✅

| What | Where |
|---|---|
| Removed from the page: `QA_BANK` (incl. ML = `3`, canned SQL/Power BI/Python paragraphs, relocate/remote sentences), `GENERIC_ANSWER`, the YES-regex / first-option picker, the in-page Gemini `fetch`, the CV object | `naukri-auto-apply.js` |
| Naukri's `__APPLY_CONFIG` no longer carries the CV or the API key (Indeed/Wellfound unchanged — out of scope) | runner `buildInjection` |
| Answer engine in Node behind `__aaAnswer({question, options, numeric, job})`: direct factual lookup (only non-empty values; derived sentences and config defaults are not facts), then Gemini | `answer-engine.js`, runner `onAnswer` |
| Gemini: model from `GEMINI_MODEL` (default `gemini-2.5-flash`), key in the `x-goog-api-key` header, only relevant facts (no email/phone/DOB/gender unless the question is about them), JSON `{status, answer, evidence, missing}`, temperature 0 | `answer-engine.js` |
| Validation: option answers must be one of the options verbatim, numeric answers must be numbers, no evidence = unknown | `validate()` |
| Unknown → the chatbot stops, job reported `SKIPPED` with reason `human-needed: <category>`; full details (question, options, stage, missing info, clicked) go to `naukri-history.jsonl`, never into the ledger | page `handleChatbot`, runner `onReport` |
| Categories: unanswerable-question, missing-info, captcha, otp, unsupported-form, manual-flow, unexpected-behaviour (login is defined, not auto-detected — a logged-out session must not permanently skip jobs) | page `detectBlocker`/`handleChatbot` |
| Loop prevention: same question back after answering → unexpected-behaviour; 15 turns → manual-flow | `handleChatbot` |
| After a SKIPPED with Apply clicked, Node reloads the job and logs what Naukri shows (history only, no count change) — for learning what an abandoned questionnaire does | runner `onReport` |
| `node answer-engine.js --check` verifies the key + model respond | `answer-engine.js` |

Design decision (flagging): a transient AI failure (`ai-error`: HTTP error, network,
non-JSON) is recorded **FAILED** (retryable, plan §9 "technical problem"), not SKIPPED,
so a Gemini outage cannot permanently close jobs. A missing `GEMINI_KEY` is treated as
"needs a human" → SKIPPED.

Tests: `answer-engine.test.js` (mocked Gemini: answered, unknown, invalid option,
invalid number, no evidence, HTTP/network/non-JSON errors → unknown with no answer,
no key → no request, key in header not URL, contact details withheld, page source has
no answers/CV/key).

Not verified: `GEMINI_KEY` is empty in this `.env`, so no real model call was made —
run `node answer-engine.js --check` after adding a key. The in-page chatbot path is not
exercised by any test (it only appears after a real Apply click); see CONTROLLED-TEST.md.

## Phase 3 — Structured events + history ✅

| What | Where |
|---|---|
| Event bus (EventEmitter) with PLAN §14 states + `deferred`, `would-apply` (DRY), `resumed`, `error`; each event `{runId, seq, ts, state, …}`; mirrored to `process.send({type:'event', event, snapshot})` when forked | `run-events.js` `createBus` |
| Live snapshot for the UI: state, phase text, current job, search, page URL, question/answer, counts (copied from the ledger run — never computed here), per-run tallies (applied / already-applied / skipped / failed / deferred / would-apply), last result | `bus.snapshot` |
| Page → Node progress via `__aaEvent` (fire-and-forget): checking-job, opening-application, submitting, filling-answer, waiting. Node alone emits outcomes (application-verified etc.) | page `emit()`, runner `onEvent`, `PAGE_STATES` |
| Node states: starting, searching, loading-results, generating-answer, verifying, application-verified, already-applied, skipped, failed, deferred, would-apply, waiting, completed, error | runner |
| `naukri-history.jsonl`: ONE `type:'job'` record per job outcome, keyed by `runId`+`jobId`: title, company, location, salary, experience, stats, tags, description, search query, results page, timeline (ts + state), questions with the engine's result (answer / evidence / missing), outcome (status, reason, verification, intervention, clicked, page state after an abandoned questionnaire). Every mode writes it, tagged `mode` | `run-events.js` `createTracker`, `naukri-history.js` |
| Job-detail selectors measured on a live job page / search card (read-only) | page `opening-application` / `checking-job` |

The ledger stays the only count source; history/events are observation only.

Tests: `run-events.test.js` (seq/runId/ts, unknown state throws, IPC mirror, tallies
keep already-applied separate, page states can't declare outcomes, one record per job
with timeline/questions/outcome, failing writer can't break a run, history file).

Verified by a forked DRY run: IPC delivered starting → searching → loading-results →
checking-job → opening-application → would-apply → waiting → deferred, and history
records carried real job details. Not verified: submitting / generating-answer /
filling-answer / verifying / application-verified / skipped events (need a click).

## Phase 4 — Desktop app (Electron) ✅

`npm run app` opens ApplyIt. `npm run app:selftest` runs the end-to-end self-test.

| What | Where |
|---|---|
| Electron main forks the unchanged CLI runner (`child_process.fork`, Electron-as-Node) and talks over IPC; the app only builds the flags a user would type, so every safety rail stays in the runner | `app/main.js`, `app/run-args.js` |
| Preload with `contextBridge`; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP `default-src 'self'`; renderer inserts data with `textContent` only | `app/preload.js`, `app/renderer/*` |
| Pages: Dashboard, Running (live state, job, job ID, search, results page URL, question/answer, run X/target, today X/50, tallies, events, runner log), Applications (ledger + deferred rows, history details; filters All / Applied / Already applied / Skipped / Failed / Deferred / Today / date range / company / title / platform), Job Details (ledger lines, per-run timeline, questions + answers + evidence, intervention, verification, captured description), Reports (outcomes, daily activity, intervention categories, failure reasons, runs), Settings (mode) | `app/renderer/*`, `app/data.js` |
| Pause (the page awaits `__aaMayStartJob` before each new job/page; the job in flight finishes and is recorded; paused time doesn't eat the 100-min deadline), Resume (continues the current page), Stop (the job in flight is verified/recorded first, then Chrome closes; the runner exits 0), Show/Hide browser (reuses `window-utils` + the `.show-windows` flag) | runner control block, `app/main.js` |
| Mode selector: DRY default (resets every launch), TEST needs job IDs/URLs (validated), LIVE needs the word LIVE typed → red banner | Settings page, `run-args.js` |
| Closing the window stops a run cleanly; if the app process disappears the runner stops itself | `before-quit`, runner `disconnect` handler |

Found and fixed by the self-test: a paused run could show "WAITING" because later
events overwrote the displayed state — `paused` is now a sticky snapshot flag.
In DRY the run counter is labelled "simulated, nothing submitted".

Tests: `app-data.test.js` (applications/job details/reports views; mode → CLI flags).
Self-test (VERIFIED): the real window + a forked DRY run — starting, searching,
loading-results, checking-job, opening-application, would-apply, paused (UI shows
PAUSED), resumed, stopped (UI shows STOPPED), runner exit 0, no Chrome left.

## Phase 5 — Resume profile + setup ✅

| What | Where |
|---|---|
| Setup page: choose resume PDF → local text extraction (pdfjs-dist, Node) → Gemini structures it (name, contact, skills, tools, languages, jobs with employers/dates, education, certifications, projects) → shown for review/edit → saved to `profile.json` | `resume-profile.js`, `app/renderer/setup.js`, `app/main.js` `setup:*` |
| No guessed fields: every extracted value must appear word-for-word in the resume text (phones compared by digits); anything else is dropped and listed on screen as "removed (not in resume)". Without a key or on an AI error only literal email/phone are pre-filled | `groundProfile`, `buildProfile` |
| "What a resume doesn't say" block (notice period, current/expected CTC, total experience, work authorization) — entered by the user, stored in `profile.json` `userProvided` | Setup |
| `preferences.json`: titles/keywords, locations (+ any), remote/hybrid/on-site, relocation, salary range, experience range, include/exclude title words, limits (can be lowered, never above 10/run, 50/day) | `preferences.js` |
| Searches built only from what the engine already uses: `https://www.naukri.com/<slug>-jobs?experience=<min years>`; no titles → built-in searches unchanged | `buildSearches`, runner |
| Title words replace the built-in keyword list; exclude words add to the built-in blocklist; preferred locations filter cards (unknown location kept, "remote" passes when remote is accepted). Salary/experience/work mode are advisory (Phase 6) | page `titleOk`/`locationOk` |
| Answer engine facts: `profile.json` (+ explicit preferences) when it exists, otherwise the `.env` CV — never mixed | runner `FACTS`, `factsFromProfile` |
| Main process never trusts renderer input: profile fields are whitelisted and type-checked before saving | `sanitizeProfile` |
| Shared Gemini JSON transport `askJson` (answers, resume, matching) | `answer-engine.js` |

Tests: `profile-setup.test.js` (real PDF generated in the test → extracted; grounding drops
an invented job, skill, certification and a normalised location; no key / AI error →
only literal email/phone; profile round-trip and facts skip empty values; limits clamp;
search URLs; title filter). Self-test additionally loads the Setup page and extracts the
configured resume inside Electron (length only).

Not verified: AI extraction against a real Gemini model (no key in `.env`). The
dependency audit reports 1 high issue in `brace-expansion`, a pre-existing transitive
dependency of playwright-extra — not introduced here and left untouched.

## Phase 6 — AI matching (advisory) ✅

| What | Where |
|---|---|
| Rule match (offline, always): profile skills found in the job text → matched; the job's own skill tags not in the profile → missing (never guessed from prose); experience range fit; preferred-location fit → score 0-100, decision, reasons | `job-match.js` `ruleMatch` |
| AI match (when `GEMINI_KEY` is set): Gemini score/decision/reasons; every matched skill must appear in both the job and the profile, every missing skill in the job and not the profile; bad score / AI error → rule result kept (`aiError` noted) | `aiMatch` |
| Runs when the job page opens (description available) → `ai-matching` event → stored in the job's history record → Running page, Job Details, Applications "Match" column, Reports average | runner `startMatch`, `run-events.js`, app |
| **Advisory only**: `startMatch` never records, excludes or skips. Threshold setting (Setup) defaults OFF; when on it only flags `belowThreshold` | `applyThreshold`, `preferences.matching` |

Tests: `job-match.test.js` (rule scoring, unknown without skills, AI grounding drops
invented skills, off-contract/offline AI → rules, threshold off by default and only
flags, source check that startMatch cannot gate, experience parsing).

Verified by a DRY run: history recorded `match {score 72, good-match, 10 matched,
5 missing (from the card's own tags), source rules}` in the timeline
checking-job → opening-application → ai-matching → would-apply.
Not verified: the Gemini match path against a real model (no key).

## Follow-up fixes ✅

| Fix | What | Where |
|---|---|---|
| 1 | A missing/invalid `GEMINI_KEY` can never produce SKIPPED: no key is now `ai-error` (→ FAILED, retryable). **TEST and LIVE refuse to start** unless `checkModel()` succeeds — the same check as `node answer-engine.js --check`, run by the runner before the LIVE prompt and before Chrome, and by the app before it launches the runner. DRY runs without a key | `answer-engine.js` `checkModel`, `safety.js` `aiPreflight`, runner start, `app/main.js` `startRun` |
| 2 | Setup collects the application facts a resume doesn't hold: notice period, current CTC, expected CTC, date of birth, gender, work authorization, current location (profile.json `userProvided`); willingness to relocate and remote/hybrid/on-site (preferences.json). Answers use the resume profile + these facts; `.env` fills ONLY these fields when Setup leaves them empty (never skills/role/etc., never config.js's invented relocate/remote sentences or its default work-auth sentence). Setup shows under each field where the value comes from (Setup / resume / `.env: …` / not set) | `resume-profile.js` `APP_FACTS`, `applicationFacts`, `factsFor`; Setup page |
| 3 | Questionnaire-stage FAILED reasons are tagged `questionnaire-stage:` (AI error in the chatbot, no confirmation after a questionnaire, unverified after a questionnaire). A job with 2 such FAILED records is SKIPPED at the click gate on its next attempt with `human-needed: repeated-questionnaire-failure` — before any click. APPLIED counting and verification unchanged | `naukri-ledger.js` `repeatedQuestionnaireFailures`, page `hadQuestionnaire`, runner `onMayClick` |

Behaviour change to note: without a saved profile, `.env` now supplies only the
application facts — questions about skills/experience need the Setup profile (or become
unknown), and the advisory match reports "unknown" until Setup has skills.

Tests (65 total): no key → ai-error; `checkModel` ok / empty key / wrong JSON / HTTP 400;
`aiPreflight` DRY ok, TEST/LIVE refused; runner source order (preflight before the LIVE
prompt and before launch); application facts (Setup wins, `.env` fallback only for the
listed fields, sources reported, defaults/invented sentences ignored, no `.env` skills
without a profile); questionnaire cap (counts only tagged FAILED, SKIPPED ends the cap,
counts untouched) and its wiring. App self-test: TEST and LIVE are refused when the AI
check fails (forced failure — cannot start a run even with a real key), plus the DRY
pause/resume/stop run.

## AI layer: Gemini primary, Groq fallback ✅

One module, `ai-providers.js` — two transports and one chain; every AI caller (answers,
resume extraction, optional matching) uses `ai.askJson()`, and validation stays above it
so no provider can bypass it (options verbatim, numeric, evidence required, resume
grounding filter, match skill grounding).

| Rule | Behaviour |
|---|---|
| Gemini 503/5xx/timeout | one retry after 3 s, then Groq |
| Gemini 429 | wait + one retry if Retry-After/RetryInfo < 10 s, else Groq |
| Gemini DAILY quota (QuotaFailure `…PerDay…`) | Gemini unavailable until midnight Pacific, persisted in `ai-state.json` (git-ignored) → straight to Groq, also in later runs |
| Groq 429/503/5xx/timeout | up to 2 retries, waiting Retry-After / `x-ratelimit-reset-*` / exponential; a wait > 20 s ends the attempt |
| Groq daily limit (RPD/TPD or remaining-requests 0) | Groq unavailable until its reported reset |
| 400/401/403/404 either provider | config error, never retried, provider disabled for the process, request falls through |
| Both unusable because of daily limits | `ai-daily-limit` → the job is a retryable FAILED (not counted toward the questionnaire cap) and the run stops cleanly: state Stopped, reason "AI daily limits reached" |
| Both transiently failing | `ai-error` → FAILED (retryable), as before |

- Models: Gemini default `gemini-3.5-flash-lite` (verified responding 2026-09-28; your
  `.env` sets `gemini-3.8-flash`, also verified). Groq has **no default** — `GROQ_MODEL`
  must be a model your key lists; `--check` prints the list when it is missing or 404s.
- `node answer-engine.js --check` tests each provider separately: works/fails + reason,
  model, remaining limits (Groq rate headers; Gemini doesn't report them). TEST/LIVE
  start if at least one works, with a warning when only one does (runner and app).
- AI matching is rules-only by default; Setup → "AI matching (uses AI quota)", default OFF.
- Only question-relevant facts are sent: professional context by default; contact, DOB,
  gender, pay, notice, location and work-authorization facts only when the question is
  about them.
- Every AI call is written to history as `type:'ai-call'` (purpose, provider, model,
  tokens, retries, fallback reason, attempts; app-side calls tagged `mode:'SETUP'`).
  Dashboard: "AI calls today — Gemini N · Groq M" + provider status.

Tests: `ai-providers.test.js` (18, mocked transports): Gemini ok; 503→retry ok; 503×2→Groq;
timeout→Groq; 429 short wait vs long→Groq; Gemini daily→Groq rest of day, persisted, back
after the Pacific reset; both daily→`daily-limit` (+ runner stop wiring); both transient;
404/401/403 never retried; Groq retries honour headers; Groq daily reset; invalid option
from Groq rejected; numeric/evidence rules on Groq; unknown from either → SKIPPED path;
`check()` lists Groq models; duration + Pacific-midnight helpers (PDT/PST); relevant-facts
filter. Older tests migrated to the chain. 83 total, all passing. App self-test passes
(TEST/LIVE refused when no provider works).

Verified for real: `node answer-engine.js --check` → gemini WORKS (gemini-3.8-flash),
groq FAILS (GROQ_API_KEY not set) → "only one provider works". DRY run made 0 AI calls.
Not verified: Groq against the real API (no key), a real Gemini daily-quota response.

### Fix: empty Groq model list in `--check`

Cause: `listModels()` never checked the HTTP status and read `data || []`, so any error
response — e.g. `HTTP 401 {"error":{"message":"Invalid API Key"}}` — became an empty list.
With `GROQ_MODEL` empty, `--check` only listed models (no chat call), so the error was
invisible. Reproduced with a deliberately invalid key; with the current `.env` key the
listing returns 11 models including `openai/gpt-oss-120b`.

Fix: `listModels()` → `{ok, models}` or `{ok:false, error}` with the actual reason (HTTP
status + provider message, non-JSON bodies, network errors, unexpected shapes); `--check`
prints `model listing FAILED: <reason>`; `--check --models` always lists both providers.

Reasoning models: Groq returns gpt-oss thinking in `message.reasoning` (verified live) and
only `message.content` is parsed; Gemini `thought` parts are excluded. The parser also
strips inline `<think>` blocks / fences and otherwise takes the last complete JSON object,
so reasoning text can't break or steer the parse. Reasoning tokens are recorded in the
per-call usage. Verified live: JSON mode with `openai/gpt-oss-120b` → option answered
verbatim ("Power BI") and an unanswerable question → `unknown / missing-info`.

Tests (+6, 88 total): listing errors (401 / HTML 403 / network / odd shape / success
filtering), `--check` output shows the listing error, parse cases (fences, `<think>`,
surrounding prose, last object wins, no JSON, arrays rejected), Groq `reasoning` field
ignored + reasoning tokens recorded, Gemini thought parts ignored.

## Setup redesign + "Needs your answer" inbox ✅

**Setup = 3 required steps** (under 2 minutes): 1) resume PDF → auto-extract, shown as a
compact read-only summary with an "Edit details" button (removed/ungrounded values in a
short collapsible list); 2) job titles + keywords, pre-filled from the resume's
current/recent titles and first skills (`suggestPreferences`, resume-only); 3) locations,
pre-filled from the current/resume city, plus "Any location" / "Remote is fine" → Save.
Everything else (application facts with their .env-fallback hints, hybrid/on-site,
relocation, salary, experience, exclude words, limits) sits under a collapsed
"More details (optional)". Setup and Settings each save only their part (merged).

**Inbox** (`question-inbox.js`, Dashboard + nav badge): SKIPPED jobs whose question
couldn't be answered truthfully (missing-info / unanswerable-question) are grouped —
identical/near-identical wording (normalised, token Jaccard ≥ 0.8), and only with the same
option set. The user answers once (option questions: the original options as buttons) →
`profile.json answeredByYou` (source "answered by you"), or "Don't answer this" →
`dontAnswer`. "Forget" undoes either. Previously SKIPPED jobs stay SKIPPED — the ledger is
never touched; only future jobs use the answer.

**Answer engine**: "don't answer" → unknown straight away (job keeps being skipped, no AI
call); a saved answer is used only if the SAME `validate()` accepts it for this question
(option verbatim, numeric); saved answers are also given to the AI as facts. Saving the
Setup profile never drops the inbox answers (`keepInbox`).

**Settings > Advanced**: "AI matching" and "Match threshold", each with a one-line
explanation; both default Off (a user's saved choice is kept).

Tests: `question-inbox.test.js` (7): grouping (wording variants, option sets, categories,
same job once), saving (validation, source, leaves the inbox, ledger untouched), saved
answer used by the engine (text + option, numeric mismatch not forced), saved answers
reach the AI as facts, "don't answer" keeps skipping without an AI call + answer/forget,
Setup pre-fill from the resume, runner/app wiring. 95 total, all passing. App self-test
(PASS) now also checks: Setup's 3 steps with "More details" collapsed, the inbox badge,
Settings > Advanced collapsed; captures include a display-only inbox sample.

Note: with "AI matching" on, DRY runs also spend AI quota (one request per job).

## Fix round from the DRY-run investigation

### Part A — Naukri filters confirmed live ✅
[NAUKRI-FILTERS.md](NAUKRI-FILTERS.md): `experience` (single 0–30), `jobAge` (1/3/7/15/30),
`wfhType` (0 office / 2 remote / 3 hybrid, multi), `cityTypeGid` (28 cities, multi),
`ctcFilter` (9 ranges, multi). A directly loaded URL with all of them is honoured.

### Part B — Setup with confirmed filters ✅
- `naukri-filters.js` holds exactly the confirmed values; `searchUrl()` drops anything else.
- Setup step 2: job-title chips (pre-filled from the resume headline + recent titles).
  Step 3: city chips from a searchable list of the 28 confirmed cities (native datalist,
  no free text) + "Any location"; Remote/Hybrid/On-site; experience from/to (Naukri takes
  one value → "from"); Posted within; optional salary ranges; live preview of the URLs.
- One search per title with every selected filter. Old free-text locations migrate to
  cities ("Pune, anywhere in india" → Pune); unknown words are listed, never used.
- Empty searches: Naukri's "No results found" page now ends that search immediately (was:
  30 s wait + restarts). Self-test pauses on the first results page, so it no longer
  depends on live results.
- Tests: `naukri-filters.test.js` (7).

### Parts C–G — low-match gate, walk-ins, pacing, location recheck, run logs ✅
- **C** Match runs only after the Apply button is found. Below the threshold (Settings >
  Advanced, default 50 %, can be Off) → not applied, SKIPPED `low-match: <score>% (rules|ai)`
  with matched/missing skills in history. Gate uses the AI score when AI matching is on,
  else rules; a matching error never blocks (fails open). Rules: Excel ≈ Advanced/Microsoft
  Excel, MySQL ≈ SQL, …; generic tags (communication, coding, …) ignored; Remote fits when
  Remote is selected. Duplicate postings (same company, ≥80 % same title words) → only the
  first is opened.
- **D** Loaded job page with no Apply control → decided 1.5 s after load: another control
  ("I am interested", "Register") → SKIPPED `unsupported-apply-route: <text>` (never
  clicked, visible buttons logged); none → SKIPPED `no-online-apply`. Not loaded → unchanged
  (wait, FAILED retryable). Employer name from the job page beats the card's industry label.
  Applications: "Walk-ins" filter shows date/venue (ledger rows only — DRY writes no ledger).
- **E** Pause only after a real/simulated apply: 45–120 s, DRY 5–15 s. None after skipped,
  deferred, filtered, no-button or already-applied jobs.
- **F** Card without a readable location → checked on the job page; outside your cities →
  "filtered" (logged, not recorded in the ledger).
- **G** Every run saves `runs/<runId>.log` + `runs/<runId>.events.jsonl` (git-ignored) with
  per-page counts (seen / title-filtered / excluded / location-filtered / duplicates /
  opened) and a final run-summary with the stop reason.

### Part H — Reset test data ✅
Settings > Advanced > "Reset test data…": confirmation dialog, then MOVES
naukri-history.jsonl, runs/ and ai-state.json into `archive/<timestamp>/` (git-ignored).
Never touches naukri-ledger.jsonl, naukri-deferred.jsonl, profile.json, preferences.json
(the dialog says so). The old in-page "seen" lists live in Chrome's localStorage and are no
longer used for anything, so there is no file to archive.
- Tests: `fix-round.test.js` (11). Full suite 113 pass.

## What's left
See the final report and [CONTROLLED-TEST.md](CONTROLLED-TEST.md). Nothing in this
build clicked Apply: TEST and LIVE are implemented and unit-tested but have not been run.
