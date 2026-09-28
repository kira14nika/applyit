# ApplyIt — Product Plan & Development State

**Updated:** 28 September 2026
**Product name:** ApplyIt (previously "JobPilot")
**Local project:** `C:\naukri_update`
**Repository:** `https://github.com/kira14nika/applyit` (private). `origin` = this repo.
**Upstream:** `https://github.com/ankitbaghel01/naukri_update` — reference only, push DISABLED.
**Current platform:** Naukri only.
**Plan file in repo:** `docs/PLAN.md` (this document). Progress log: `docs/PROGRESS.md`.

---

## 1. Product vision

ApplyIt is an AI-powered job application desktop app. For each platform (Naukri first) it should:

1. Read the user's resume and build an editable profile.
2. Take job preferences through a short Setup.
3. Search the job portal using the portal's own filters.
4. Score each job against the profile and skip weak matches (with the reason recorded).
5. Apply only when the application can be completed reliably and truthfully.
6. Answer application questions with AI, using only the user's real information.
7. Never invent personal information. If an answer can't be established, skip the job and record why.
8. Independently verify every application before counting it.
9. Keep a permanent, inspectable history of everything the bot did.
10. Let the user pause, resume, stop, show and hide the browser.
11. Use safe modes (DRY / TEST / LIVE) so testing never makes accidental real applications.
12. Learn from skipped cases (the "Needs your answer" inbox and intervention statistics).

---

## 2. Core rules (non-negotiable)

- **Truthfulness:** the AI never invents personal information, never picks an arbitrary option, and has no generic fallback answer. Unknown → the job is SKIPPED with the exact question recorded.
- **A click is not an application.** Success = new application submitted → independently verified (job reloaded, visible "Applied") → recorded in the ledger. Only then does it count.
- **The ledger (`naukri-ledger.jsonl`) is the only quota authority.** Append-only. Never delete or rewrite it — it holds the real verified application and permanent exclusions.
- **Preserve the proven Naukri engine:** ledger semantics, verification, already-applied detection, pagination / `framenavigated` / resume-after-restart, `__aaReport`, existing selectors and click sequences. Wrap, don't rewrite.
- **Human-only steps are skipped, not waited on**, and recorded with reason, stage, question and required action. The run continues.
- **Platforms stay separate** (config, history, limits, automation).
- **Development retains detailed history.**

---

## 3. Status definitions

| Status | Meaning | Counts toward quota | Future attempts |
|---|---|---|---|
| APPLIED (verified) | New application submitted and verified on reload | Yes | Never again |
| APPLIED / already-applied | Naukri already showed "Applied" before ApplyIt clicked | No | Never again |
| SKIPPED | Deliberately not applied (see reasons below) | No | Never again |
| FAILED | Could not establish completion (technical/uncertain) | No | Retryable |
| DEFERRED | "Apply on company site" job, parked in `naukri-deferred.jsonl` (not the ledger) | No | Not revisited while company-site applies are paused |

SKIPPED reasons in use: `human-needed: <category>` (unanswerable-question, missing-info, captcha, otp, login, unsupported-form, manual-flow, unexpected-behaviour, repeated-questionnaire-failure), `low-match: <score>% (rules|ai)`, `no-online-apply`, `unsupported-apply-route: <button text>`.

FAILED rules: AI outage or missing AI key → FAILED (retryable), never SKIPPED. After 2 questionnaire-stage FAILED records for the same job, the next attempt records SKIPPED `human-needed: repeated-questionnaire-failure`.

---

## 4. Modes and safety

- **DRY (default):** searches, opens jobs, reads details, scores, detects apply routes, but never clicks Apply. Nothing written to the ledger. Chatbot questions are never reached (they appear only after clicking Apply).
- **TEST:** `--test --only=<jobId,...>` — real submission allowed only for allow-listed job IDs.
- **LIVE:** requires `--live` plus explicit confirmation (`--confirm-live` or typing LIVE); red banner in the app.
- **Node click gate:** before any real Apply click, the page asks Node (`__aaMayClick(jobId)`); no answer or a denial = no click.
- **AI preflight:** TEST and LIVE refuse to start unless at least one AI provider passes `node answer-engine.js --check`.
- **One run at a time.** Two runs sharing the bot Chrome profile collide (see Known issues).

---

## 5. Limits

- Maximum allowed: **10 successful applications per run, 50 per day.** Setup can lower these, never raise them.
- **Current test settings: 3 per run, 5 per day.**
- Only new verified APPLIED counts. Already-applied, SKIPPED, FAILED and DEFERRED never count.
- Daily count uses the local calendar day.

---

## 6. Architecture (as built)

```
Electron desktop app (app/: main, preload, renderer, data.js, run-args.js)
      │  forks runner, IPC events + controls (pause/resume/stop/show/hide)
      ▼
auto-apply-runner.js  (Node/Playwright supervisor, headed Chrome, profile .naukri-apply-profile)
      │  injects naukri-auto-apply.js into Naukri search pages
      │  bindings: __aaReport (outcomes), __aaMayClick (click gate), __aaAnswer (AI answers), __aaEvent (states)
      ▼
Supporting modules: safety.js, answer-engine.js, ai-providers.js, question-inbox.js, job-match.js,
resume-profile.js, preferences.js, naukri-filters.js, naukri-ledger.js, naukri-history.js,
naukri-deferred.js, run-events.js, run-log.js, jsonl.js, window-utils.js
```

**Data files (all gitignored, personal):**

| File | Role |
|---|---|
| `naukri-ledger.jsonl` | Authoritative outcomes + quota. Never delete. |
| `naukri-history.jsonl` | Detailed per-job records (details, timeline, questions/answers, match, AI calls, verification) |
| `naukri-deferred.jsonl` | Company-site jobs parked for later |
| `profile.json` | Resume-extracted profile + application facts + "answered by you" inbox answers |
| `preferences.json` | Search/filter preferences, limits, advanced settings |
| `runs/<runId>.log`, `runs/<runId>.events.jsonl` | Saved run logs and events |
| `ai-state.json` | AI provider daily-quota state |
| `.env` | Keys and fallback facts |

Legacy (not authoritative for Naukri): `applications.csv` (human-readable only), `apply-state-naukri.json`, localStorage `autoApplyNaukri`.

App pages: Dashboard (real state, counts, AI calls per provider, "Needs your answer" inbox), Setup, Running, Applications (filters incl. Already applied and Walk-ins), Job Details, Reports, Settings (mode, Advanced).

---

## 7. AI

- **Primary:** Gemini `gemini-3.5-flash-lite` (about 500 free requests/day; recent full Flash models only about 20/day on free tier).
- **Fallback:** Groq `openai/gpt-oss-120b` (1,000 requests/day, 8,000 tokens/minute on free tier; reasoning is returned separately and never parsed).
- **Chain:** Gemini (1 quick retry on 503/5xx/timeout) → Groq (up to 2 retries). Gemini daily quota exhausted → Groq until midnight Pacific. Both at daily limits → run stops cleanly. 400/401/403/404 → config error, no retry.
- **Validation for every provider:** structured JSON, answered/unknown, options must match verbatim, numeric answers numeric, evidence required, resume grounding for extraction.
- **Only relevant facts are sent** per question. Keys never enter the Naukri page.
- **What uses AI:** resume extraction (once), questionnaire questions that aren't simple facts, optional AI matching. Searching, clicking, verification, ledger and simple facts use no AI.
- **Verified live:** "How many years have you managed a team of 20 people?" → `unknown / missing-info` (correct).
- **Check:** `node answer-engine.js --check` (add `--models` to list available models).

---

## 8. Naukri search filters (confirmed live — see docs/NAUKRI-FILTERS.md)

- Freshness: `jobAge` = 1, 3, 7, 15, 30
- Experience: `experience` = 0–30
- Work mode: `wfhType`
- Cities: `cityTypeGid` (28 cities mapped)
- Salary: `ctcFilter` (9 ranges)
- Searches are built one per job title with the selected filters. Only confirmed filters may be used.
- An empty search ("No results found") is detected and the runner moves on immediately.

---

## 9. Setup design

**Required (about 2 minutes):**
1. Resume upload → automatic extraction → compact summary with Edit; dropped (ungrounded) values listed.
2. Job titles as chips, pre-filled from the resume headline and recent titles.
3. Cities (searchable dropdown of confirmed Naukri cities, chips, or Any location), work mode checkboxes (Remote / Hybrid / On-site), experience min/max dropdowns, posted-within dropdown, live preview of search URLs.

**More details (optional) — redesign pending (see section 14):** notice period (days field + "Immediate joiner" checkbox that sets 0 days), current/expected CTC in LPA, current location (city dropdown), relocation Yes/No, date of birth, gender, work authorization, salary filter, excluded title words, limits. Each field shows where its value comes from. Blank = not answered (no invented defaults).

**"Needs your answer" inbox:** questions that caused skips are grouped; the user answers once (or chooses "Don't answer this"); saved answers are validated like any fact and used for future jobs only. Already-SKIPPED jobs stay skipped.

---

## 10. Matching and job selection

- Match score with matched/missing skills and reasons, stored in history and shown in the app.
- **Rules matching (default, no AI):** fuzzy skill equivalents (Excel ≈ Advanced Excel ≈ Microsoft Excel, MySQL ≈ SQL), generic tags ignored, Remote counts as a fit when remote is selected.
- **AI matching:** optional (Settings → Advanced), costs one AI request per opened job. Runs only after the Apply-button check.
- **Low-match gate:** below the threshold (default 50%, adjustable, can be Off) → SKIPPED `low-match`. Gate uses the AI score when AI matching is on, otherwise the rules score. User's saved settings currently: AI matching ON, threshold 60%.
- **Duplicates:** near-identical postings from the same company → only the first is opened.
- **Walk-ins / no online apply:** detected within about 1–2s after load. No apply control → SKIPPED `no-online-apply`. Another apply-like button ("I am interested", etc.) → never clicked, SKIPPED `unsupported-apply-route`. Unclear page → wait, then FAILED (retryable). Walk-ins have their own filter in Applications.
- **Company-site jobs:** DEFERRED. Company-site auto-apply stays paused until integrated with ledger, verification and counting.
- **Employer name** taken from the job page when the card shows an industry label.

---

## 11. Pacing

- 45–120s pause only after a real or simulated apply. No pause after skipped, deferred, no-button or filtered jobs.
- DRY mode: 5–15s pauses.
- Other waits: supervisor check every 45s (wakes early when a search ends), search rotation after inactivity, browser restart after repeated no-progress cycles (max 8), 100-minute run cap.

---

## 12. Implementation status

| Area | Status |
|---|---|
| Naukri search, title filter, direct Apply | Implemented, verified live (1 application) |
| Ledger, quota (10/run, 50/day), exclusions | Implemented, verified by test + live |
| Reload verification, already-applied detection | Implemented, verified live (Leaz Edutech, Ecolab) |
| Pagination, resume after restart | Implemented, verified in DRY |
| Safety modes, click gate, LIVE confirmation, AI preflight | Implemented, verified by test (TEST/LIVE never run) |
| Truthful answer engine, inbox | Implemented, verified by test + live AI calls; in-page chatbot flow NOT verified (needs a real click) |
| Gemini → Groq chain | Implemented, both providers verified live |
| Events, history, saved run logs | Implemented, verified by test + DRY |
| Electron app (all pages, pause/resume/stop, show/hide) | Implemented, verified by self-test |
| Resume extraction | Implemented, verified with real resume |
| Naukri filters + new Setup steps 1–3 | Implemented, filters verified live |
| Low-match gate, walk-in detection, pacing, duplicates, reset test data | Implemented, tests passing (113); final DRY report pending |
| More details redesign, lock handling, leftover-Chrome fix | Pending (next prompt) |
| Controlled real test of the questionnaire flow | Not done |
| Company-site auto-apply | Paused (not in scope) |

---

## 13. Known issues

1. **Leftover Chrome after a finished run:** a bot Chrome stayed open after Claude Code's DRY run finished and held the profile lock; the next app run failed with "profile already in use". Closed manually. Fix pending.
2. **Profile lock wait never gives up:** the runner retries every 30s forever. Fix pending (3 tries, then stop with a clear message; app refuses to start a second run).
3. **"More details (optional)" still uses the old plain-text UI.** Redesign pending.
4. **Unknown Naukri behaviour when the bot abandons a questionnaire** after clicking Apply. To be learned in the controlled test.
5. Indeed/Wellfound engines exist but are dormant and out of scope. Scheduling code exists but is not used and not in scope.
6. `npm audit`: one high-severity issue in `brace-expansion` via `playwright-extra` (existing, low priority).
7. Early commits carry a placeholder author email; git is now set to the correct GitHub noreply address.
8. API keys that appeared in an earlier version of this document should be rotated if not already.

---

## 14. Next steps

1. **Send the follow-up prompt** to Claude Code: leftover-Chrome fix, lock handling, More details redesign (notice period days + Immediate joiner = 0 days).
2. **Fill the new Setup** with the target profile (section 15). Consider AI matching off to save quota; threshold 50%.
3. **Reset test data** (Settings → Advanced). Never touches the ledger.
4. **Fresh DRY run** → Claude Code investigation of the saved run log → review.
5. **Controlled test** (`docs/CONTROLLED-TEST.md`) on 1–2 allow-listed jobs with questionnaires — review with the chat before running.
6. Then LIVE use with low limits, raising gradually to 10/run and 50/day.

---

## 15. User targeting

- Target titles: **Data Analyst, Power BI Developer, MIS & Reporting Analyst**.
- About 2 years of analyst experience (Data Analyst role plus internship); earlier customer-service and tech-support roles.
- Skills: SQL, Power BI (DAX, Power Query), Excel, Python (Pandas, NumPy, Matplotlib, Seaborn, Scikit-learn), Tableau.
- Search: Pune (plus other cities if chosen), experience 1–3 years, posted within 3–7 days.
- The resume was updated to remove "Business Analyst" from the headline; the same titles should be used in ApplyIt Setup and the Naukri profile.

---

## 16. Do not build yet

- Indeed or other platforms
- Automatic scheduling
- Company-site (external) auto-apply
- Animations / Goku / Dragon Ball dashboard
- Unnecessary refactors of the proven engine

---

## 17. Working rules

- Claude Code reads `CLAUDE.md`, `docs/PLAN.md` and `docs/PROGRESS.md` at the start of each session.
- Inspect before changing; smallest change; test; commit per phase; update `docs/PROGRESS.md`.
- Claude Code never runs `--live` or `--test`. Controlled tests are run by the user.
- Only one ApplyIt run at a time.
- Clearly label status: IMPLEMENTED / PARTIAL / VERIFIED BY TEST / NOT VERIFIED / BROKEN.
