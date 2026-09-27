# Controlled TEST run — 1–2 allow-listed Naukri jobs with a chatbot questionnaire

This is the first time ApplyIt's **new answer engine** meets a real Naukri questionnaire,
and the first time we learn **what Naukri does when the bot abandons one**. It makes REAL
applications, but only to the job IDs you allow. Nothing else can be clicked: every
other job is denied by the Node click gate (`🔒 click gate: … → DENY (TEST)`).

Run it yourself, watching. Budget ~15 minutes.

---

## 0. Before you start

1. **No other run is active** (the app's Running page is idle, no `auto-apply-runner` in Task Manager).
2. **Decide about AI answers.**
   - With a Gemini key: add `GEMINI_KEY=…` (and optionally `GEMINI_MODEL=…`) to `.env`, then check it:
     ```bash
     node answer-engine.js --check
     ```
     You want `"status":"answered","answer":"4"`. Anything else → fix the key/model first.
   - Without a key: only direct facts (email, phone, name, notice period, CTC, current
     company/location, links) can be answered; **every other question stops the
     questionnaire and the job becomes SKIPPED** (`human-needed: unanswerable-question`).
     That is still a valid test of the abandonment behaviour.
3. **Optional but recommended:** fill in Setup (`npm run app` → Setup): review the
   profile, and fill "What a resume usually doesn't say" (notice period, CTC, total
   experience). Otherwise answers come from `.env`.
4. Run the offline checks once:
   ```bash
   node --test
   ```

## 1. Pick the jobs

A questionnaire only appears **after** Apply is clicked, so nobody can know in advance
whether a job has one. Pick 1–2 jobs that:

- you would genuinely be happy to apply to (these are real applications),
- say **Apply** (NOT "Apply on company site"),
- are not already in ApplyIt's records.

Copy each job's URL from the address bar, e.g.
`https://www.naukri.com/job-listings-data-analyst-acme-pune-2-to-5-years-123456789012`
(the trailing number is the job ID). Check it isn't recorded already:

```bash
node -e "const L=require('./naukri-ledger'),D=require('./naukri-deferred');const id=L.jobId(process.argv[1]);console.log(id,'ledger:',L.load().filter(r=>r.jobId===id).map(r=>r.status+' '+r.reason),'deferred:',D.ids().has(id))" "PASTE_JOB_URL"
```

Use the **URL** (not just the ID) — ApplyIt then opens the job directly instead of
hoping it shows up in a search.

## 2. Run it

**Desktop app:** `npm run app` → Settings → **TEST** → paste the URL(s), one per line →
tick "Show the browser window" → Running → **Start**.

**Or the CLI:**
```bash
node auto-apply-runner.js naukri --test --only=URL1,URL2 --show
```

The run's target is the size of the allow-list, and it ends by itself once every
allow-listed job has an outcome. **Stop** (app) or Ctrl+C (CLI) at any time — a job
in flight is recorded first.

## 3. What to watch (Running page / log)

| You see | Meaning |
|---|---|
| `TEST — real clicks ONLY for job ids: …` | the allow-list is active |
| `🔒 click gate: <id> → ALLOW (TEST)` / `Submitting` | the Apply click for YOUR job |
| `🔒 click gate: <other id> → DENY (TEST)` | any other job — not clicked, not recorded |
| `🤖 Q: "…"`, then `💬 answered (fact\|ai) from …` | a question and the evidence the answer came from |
| `❔ unknown (<category>): …` then `⏭ chatbot stopped` | no truthful answer → questionnaire abandoned |
| `⏭ SKIPPED — human-needed: <category> \| Q: "…"` | recorded SKIPPED (permanent) with the question |
| `(after abandoning, the job page reads: applied\|not-applied\|unknown)` | **what Naukri shows right after we walked away** — the key observation |
| `✔ verified — job page shows Applied` → `==> 1/…` | a completed, verified NEW application (counted) |
| `❌ not verified (…) — recorded FAILED` | the page did not show Applied — not counted, retryable |

Watch the visible browser too: note exactly which question the bot stopped on and
what the drawer looked like.

## 4. Check what was recorded

```bash
node -e "const L=require('./naukri-ledger');console.log(L.load().slice(-4))"
```
```bash
node -e "const H=require('./naukri-history');for(const h of H.load().filter(x=>x.type==='job'&&x.mode==='TEST').slice(-2))console.log(JSON.stringify({jobId:h.jobId,questions:h.questions,outcome:h.outcome},null,1))"
```
Or in the app: Applications → click the job → Job Details (timeline, every question
with its answer and evidence, the intervention, and "after abandoning, the job page read: …").

## 5. What does Naukri do with an abandoned questionnaire? (the open question)

Only needed if a job ended **SKIPPED after Apply was clicked** (`clicked: true`).

1. Note `pageStateAfterAbandon` from step 3/4.
2. After the run ends, open **your normal browser** (logged in to Naukri):
   - My Naukri → **Applies / Applied jobs**: is the job listed? With what status?
   - Open the job page: does it show **Applied**, **Apply**, or something else?
   - Click **Apply** yourself: does the questionnaire resume where it stopped, start
     over, or say you already applied? (If it resumes, you can finish it by hand.)
3. Look again **the next day** — some states may only settle later.
4. Write down the answers. They decide the next design step:
   - **Naukri lists it as applied** → an abandoned questionnaire can produce a real
     (incomplete) application. ApplyIt then records it as SKIPPED although it counts
     on Naukri's side; we would need to change when/how the bot commits to Apply.
   - **Not applied, questionnaire restarts** → SKIPPED is correct; you can finish the
     job by hand, and a later ApplyIt version could retry once the profile has the
     missing information.

## 6. Safety recap

- Only the allow-listed job IDs can be clicked; the page will not click if the gate is
  missing, errors, or says anything but yes.
- TEST writes the ledger only for allow-listed jobs. Counts still move only after the
  job page is reloaded and shows Applied.
- Never add `--live` for this test.
