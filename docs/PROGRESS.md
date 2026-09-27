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

## Next — Phase 2: truthful answers
Remove invented answers (YES/first-option picker, GENERIC_ANSWER, canned QA_BANK
narratives), move Gemini into Node behind `__aaAnswer`, SKIPPED + intervention details
for anything unknown.
