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

## What's left
See the final report and [CONTROLLED-TEST.md](CONTROLLED-TEST.md). Nothing in this
build clicked Apply: TEST and LIVE are implemented and unit-tested but have not been run.
