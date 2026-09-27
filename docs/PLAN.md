# JobPilot — Complete Product Plan & Current Development State

**Date:** 27 September 2026
**Project:** `C:\naukri_update`
**Repository:** `https://github.com/ankitbaghel01/naukri_update`
**Current platform:** Naukri
**Current priority:** Finish and stabilize Naukri before adding other platforms.

---

# 1. PRODUCT VISION

JobPilot is an AI-powered job application automation desktop application.

The first platform is Naukri.

The eventual goal is for JobPilot to:

1. Read the user's resume.
2. Extract useful information from the resume.
3. Let the user configure job preferences.
4. Search Naukri for relevant jobs.
5. Use AI to match jobs against the user's resume/profile.
6. Open suitable jobs.
7. Apply automatically when the application can be completed reliably.
8. Use AI to generate answers to application questions.
9. Fill application forms automatically.
10. Use the user's own information when generating answers.
11. Never invent personal information.
12. Skip applications that genuinely require human intervention.
13. Record exactly why an application was skipped or failed.
14. Independently verify successful applications.
15. Permanently record application history.
16. Allow the user to inspect everything the bot did.
17. Allow the user to pause, resume, stop, show, and hide the browser.
18. Provide safe development/testing modes so unnecessary real applications are not made.
19. Eventually use information about skipped/intervention cases to improve JobPilot.

---

# 2. IMPORTANT PRODUCT PHILOSOPHY

## User provides information once

The user should NOT have to manually create an answer bank.

The user's information should primarily come from:

* Resume
* Resume-derived profile
* Setup preferences
* Explicit information entered by the user when the resume cannot provide it

The AI then uses this information throughout the application process.

---

# 3. RESUME AS THE PRIMARY SOURCE OF USER INFORMATION

When the user provides a resume, JobPilot should extract as much useful information as possible.

Potential information:

* Name
* Email
* Phone
* Skills
* Technical skills
* Software/tools
* Programming languages
* Previous jobs
* Job titles
* Employers
* Employment history
* Years of experience
* Education
* Certifications
* Projects
* Relevant experience
* Achievements
* Resume text

The extracted information should be visible to the user and editable.

The user should not need to repeatedly enter information that already exists in the resume.

---

# 4. SETUP PAGE

The Setup page should collect information that cannot reliably be extracted from the resume.

## Job preferences

Potential fields:

* Desired job titles
* Search keywords
* Preferred cities/locations
* Remote
* Hybrid
* On-site
* Any location
* Willingness to relocate
* Minimum salary
* Maximum salary
* Experience range
* Employment type
* Preferred industries
* Include keywords
* Exclude keywords

The exact fields should be finalized according to what Naukri actually supports.

## Resume

Setup should allow the user to:

* Select/upload resume
* View extracted information
* Edit extracted information
* Replace/update resume

## Application limits

Current desired limits:

* Maximum successful applications per run: 10
* Maximum successful applications per day: 50

Only verified NEW applications count.

---

# 5. AI JOB MATCHING

AI should match jobs against the user's actual information.

Inputs can include:

* Resume
* Extracted user profile
* Job preferences
* Job title
* Job description
* Location
* Experience requirements
* Salary information
* Other relevant job information

The system should not simply apply to every job matching a keyword.

AI should determine whether the job is relevant to the user's profile and preferences.

For development, we want to retain the reasoning/data used for matching.

Example:

```
Job: Data Analyst

AI Match: 92%

Matched:
- SQL
- Python
- Power BI
- Excel

Missing:
- Tableau
```

The exact matching algorithm, threshold, and scoring system are NOT finalized yet.

---

# 6. AI APPLICATION QUESTION ANSWERING

There will be NO manual Answer Bank.

The AI should generate application answers using:

* Resume
* User profile
* Setup information
* Job description
* Application question
* Other trustworthy information available from the application context

The AI should automatically fill supported application fields.

Examples:

## Resume-based question

Question:

```
Describe your experience with Power BI.
```

AI uses the resume/profile and generates an appropriate truthful answer.

## Job-specific question

Question:

```
Why are you interested in this position?
```

AI can use:

* User's experience
* Skills
* Job history
* Job description
* Job title

to generate a relevant answer.

## Factual question

Question:

```
How many years of experience do you have with SQL?
```

AI uses the user's actual profile/resume information.

---

# 7. AI MUST NOT INVENT PERSONAL INFORMATION

This is a major requirement.

If the answer cannot be established reliably from the user's available information, AI must NOT make something up.

Example:

```
Question:
"How many years have you managed a team of 20 people?"
```

If the user's information does not establish this:

```
Do NOT answer:
"5 years"
```

Instead:

```
SKIPPED

Reason:
AI could not determine a truthful answer.

Question:
How many years have you managed a team of 20 people?

Required intervention:
User input
```

This information should be recorded for future optimization.

---

# 8. WHAT COUNTS AS A SUCCESSFUL APPLICATION

A click on Apply is NOT enough.

A successful new application requires:

1. JobPilot performs the application.
2. Submission succeeds.
3. JobPilot independently verifies that the application exists.
4. The verified result is successfully recorded in the ledger.

Only then does the application count toward:

* 10 per run
* 50 per day

---

# 9. APPLICATION STATUS DEFINITIONS

## APPLIED

A NEW application was submitted and independently verified.

Counts toward the successful application quota.

Example:

```
APPLIED
Reason:
verified: Applied on reload
```

---

## ALREADY APPLIED

The user had already applied before JobPilot attempted to apply.

This does NOT count toward the successful application quota.

However, the job should be permanently excluded from future application attempts.

Example:

```
APPLIED
Reason:
already-applied
```

The UI should display this separately from successful new applications.

---

## SKIPPED

JobPilot deliberately did not submit the application.

Examples:

* Human intervention required
* CAPTCHA
* OTP required
* Unsupported application form
* Required personal information unavailable
* AI cannot answer question truthfully
* Unexpected manual step
* Other human-only action

Skipped jobs do NOT count toward the successful application quota.

Skipped jobs should be permanently excluded from future attempts.

---

## FAILED

JobPilot attempted to process the job but could not establish successful completion.

Examples:

* Website error
* Browser failure
* Application submission uncertain
* Verification failure
* Unexpected technical problem

FAILED does NOT count toward the quota.

FAILED remains retryable unless later converted into another final status.

---

# 10. HUMAN INTERVENTION SYSTEM

If something requires a human, JobPilot should NOT stop the entire run.

It should:

1. Identify the problem.
2. Record exactly what happened.
3. Record what intervention was required.
4. Mark the job SKIPPED.
5. Continue to the next eligible job.

Example:

```
STATUS:
SKIPPED

Reason:
Human intervention required

Intervention:
Custom written answer required

Question:
"Describe your experience managing a team."

Stage:
Application questionnaire

Action:
Skipped
```

This data is important because it tells us what JobPilot needs to improve.

---

# 11. INTERVENTION DATA SHOULD BE ANALYZABLE

Eventually we should be able to see things such as:

```
Custom question       12
CAPTCHA                 8
OTP                     4
Unsupported form        7
Missing information     3
External/manual flow   15
```

This will allow us to identify the biggest blockers to automation.

The purpose is not just to report failures.

The purpose is to learn:

```
"What prevents JobPilot from completing applications?"
```

Then improve those areas.

---

# 12. PERMANENT HISTORY

For the DEVELOPMENT version, keep as much useful information as practical.

Do NOT aggressively delete information yet.

Potential information to retain:

## Job information

* Platform
* Job ID
* URL
* Job title
* Company
* Location
* Salary
* Experience requirement
* Job description

## Search information

* Search query
* Search page
* Search timestamp
* Discovery timestamp

## AI information

* Match result
* Match reasoning/data
* Matching skills
* Missing skills
* AI decision

## Application information

* Application route
* Application steps
* Questions encountered
* Generated answers
* Fields filled
* Submission result
* Verification result

## Intervention information

* Intervention required
* Question
* Reason
* Stage
* Required user action

## Technical information

* Errors
* Failure reasons
* Relevant events
* Timestamps
* Debugging information

Later, when the system is mature, we can decide what information should NOT be retained.

For now:

```
KEEP MORE INFORMATION.
```

---

# 13. DASHBOARD

The first version should NOT use Goku/Dragon Ball animations.

That idea can be revisited later.

For now, show real status clearly.

Example:

```
JOBPILOT                         Naukri

● RUNNING

🔎 SEARCHING

Finding suitable jobs...

Current Job:
Data Analyst

Company:
ABC Technologies

Location:
Pune

Page:
3

RUN:
4 / 10

TODAY:
17 / 50

Applied:
4

Already Applied:
2

Skipped:
3

Failed:
0

Current status:
Checking application requirements

[ PAUSE ]                 [ STOP ]
```

The status must represent real automation state.

No fake progress.

---

# 14. REAL-TIME STATUS STATES

The system should have structured states such as:

1. Starting
2. Searching
3. Loading results
4. Checking job
5. AI matching
6. Opening application
7. Filling application
8. Generating answer
9. Filling answer
10. Submitting application
11. Waiting
12. Verifying application
13. Application verified
14. Already applied
15. Skipped
16. Failed
17. Paused
18. Stopped
19. Completed

Example workflow:

```
SEARCHING
    ↓
CHECKING JOB
    ↓
AI MATCHING
    ↓
OPENING APPLICATION
    ↓
GENERATING ANSWER
    ↓
FILLING ANSWER
    ↓
SUBMITTING
    ↓
WAITING
    ↓
VERIFYING
    ↓
APPLICATION VERIFIED
```

If intervention is required:

```
SKIPPED

Reason:
Human intervention required
```

---

# 15. DESKTOP APPLICATION

The current direction is a normal desktop application window.

It is NOT an overlay.

Planned navigation:

```
Dashboard
Setup
Running
Applications
Reports
Settings
```

A Job Details view should be accessible from application history.

---

# 16. RUNNING PAGE

The Running page should show detailed live information.

Potential information:

* Platform
* Current search
* Search query
* Current results page
* Current URL
* Current job
* Company
* Job ID
* Current automation phase
* AI matching status
* Current application step
* Current question
* Generated answer when appropriate
* Run progress
* Today's progress
* Recent events

Controls:

* Pause
* Resume
* Stop
* Show Browser
* Hide Browser

---

# 17. APPLICATIONS PAGE

This should show processed jobs.

Possible filters:

* All
* Applied
* Already Applied
* Skipped
* Failed
* Today
* Date range
* Company
* Job title
* Platform

Each row should contain useful information such as:

* Date
* Job
* Company
* Location
* Status
* Reason
* Match
* Platform

---

# 18. REPORTS PAGE

Reports should contain complete historical information.

Possible reports:

* Daily activity
* Run activity
* Applications
* Skipped jobs
* Failed jobs
* Already-applied jobs
* AI matching statistics
* Human-intervention statistics
* Application success information

The development version should prioritize detailed information over minimal storage.

---

# 19. JOB DETAILS PAGE

Selecting a job should show everything recorded for that job.

Example:

```
Data Analyst
ABC Technologies

Location: Pune
Salary: ₹6–10 LPA
Experience: 2–4 years

AI MATCH:
92%

MATCHED SKILLS:
SQL
Python
Power BI
Excel

MISSING:
Tableau

APPLICATION:
Applied

TIMELINE:

10:32 — Job discovered
10:33 — AI matching
10:34 — Application opened
10:35 — Form completed
10:35 — Submitted
10:36 — Verified
```

For skipped jobs:

```
STATUS:
SKIPPED

WHY:
Human intervention required

QUESTION:
"Why should we hire you?"

REQUIRED INTERVENTION:
User answer required
```

---

# 20. PAUSE / RESUME

The user should be able to pause and resume.

Pause should be graceful.

The bot should:

* Stop starting new jobs.
* Safely finish/record the current operation where practical.
* Enter PAUSED state.
* Resume from the appropriate position.

It should not unnecessarily restart from page 1.

The existing Naukri pagination/resume system should be preserved.

---

# 21. STOP

STOP should safely terminate the run.

The system should record the final state.

No successful application should be counted merely because the bot was stopped after clicking Apply.

Verification and ledger rules still apply.

---

# 22. BROWSER CONTROL

During development, the user should have full browser control.

Controls:

* Show Browser
* Hide Browser
* Pause
* Resume
* Stop

The Naukri bot currently uses headed Chrome because Naukri may block headless operation.

The eventual normal experience can keep browser windows hidden/background.

Debug mode should allow the browser to remain visible.

---

# 23. TESTING MODES

Avoid unnecessary real applications on the user's personal Naukri account.

There should be multiple modes.

## DRY RUN

Default development/testing mode.

The bot can:

* Search Naukri
* Open jobs
* Read descriptions
* AI match
* Open application forms
* Detect questions
* Generate answers
* Fill supported fields
* Navigate the application
* Reach the final submission point

But the final real submission is blocked.

This should allow extensive testing without creating real applications.

---

# 24. CONTROLLED REAL TEST MODE

There should be a controlled mode where real submission is allowed ONLY for explicitly authorized test job IDs.

Example:

```
TEST MODE

Authorized Job IDs:

190626020642
```

If another job is encountered:

```
Not an authorized test job
→ Do not submit
```

This prevents accidental real applications during testing.

---

# 25. LIVE MODE

Live mode performs real applications.

It should require an explicit user action.

The UI should clearly indicate:

```
LIVE
REAL APPLICATIONS WILL BE SUBMITTED
```

The user should not accidentally enter live mode during development.

---

# 26. PLATFORM SEPARATION

Platforms should remain separate.

Example:

```
JobPilot

    Naukri
        Setup
        Running
        Applications
        Reports

    Indeed
        Setup
        Running
        Applications
        Reports
```

Naukri and Indeed should not share fragile platform-specific automation logic.

Indeed is NOT current scope.

---

# 27. SCHEDULING

Automatic scheduling is NOT part of the current version.

Do not build scheduling now.

It can be added later.

---

# 28. CURRENT NAUKRI ENGINE

Project:

```
C:\naukri_update
```

Repository:

```
https://github.com/ankitbaghel01/naukri_update
```

The Naukri automation engine has already undergone several development phases.

---

# 29. PHASE 1 — COMPLETED

Fixed:

* `auto-apply-runner.js` syntax error
* `naukri-auto-apply.js` encoding corruption

Preserved existing functionality:

* Data Analyst / BI keywords
* Machine Learning answer = `3`
* Direct Apply synthetic mouse-event sequence
* Chatbot mouse-event sequence
* `/myapply/` handling
* Existing selectors
* QA_BANK
* Gemini logic
* External hooks
* Logging markers

Static checks passed.

A bounded dry run:

* Launched Chrome
* Used bot profile
* Injected Naukri script
* Reached a Naukri Data Analyst job
* Detected Apply
* Did NOT make a real application
* Left no Chrome process running

---

# 30. PHASE 2A — PERSISTENT LEDGER COMPLETED

Created:

```
naukri-ledger.js
naukri-ledger.test.js
```

Persistent ledger:

```
naukri-ledger.jsonl
```

Ledger is gitignored.

Final statuses:

* APPLIED
* SKIPPED
* FAILED

Fields include:

* timestamp
* local calendar day
* job ID
* URL
* title
* company
* route
* status
* reason

Job IDs use the trailing numeric Naukri ID where available.

Fallback is the URL without query parameters.

Important semantics:

* APPLIED permanently excludes job
* SKIPPED permanently excludes job
* FAILED remains retryable

The local calendar date is used for daily counting rather than UTC.

Phase 2A tests:

```
9 passed
0 failed
```

---

# 31. PHASE 2B — LEDGER INTEGRATION COMPLETED

The Naukri runner now uses the ledger as the authoritative application-count source.

Current limits:

```
Daily cap = 50
Run cap = 10
```

Run target is based on remaining daily capacity.

The runner:

* Loads ledger
* Counts today's APPLIED records
* Excludes `reason: already-applied` from successful quota
* Calculates remaining run target
* Passes excluded job IDs into browser
* Uses the same `jobId()` logic in Node and browser
* Uses structured `__aaReport(...)` communication
* Independently verifies applications
* Records verified results
* Increments successful count only after verification + ledger append

Existing:

```
applications.csv
```

remains but is NOT the source of truth.

Existing:

```
apply-state-naukri.json
```

is also NOT authoritative.

---

# 32. COMPANY-SITE APPLICATIONS

Naukri jobs that lead to external company websites are currently intentionally PAUSED.

Reason:

* External application flow is not yet ledger-integrated.
* We need to prevent duplicate applications.
* We need proper verification/counting before enabling it.

Do not enable external company-site auto-apply until it is properly integrated.

---

# 33. APPLIED-STATE VERIFICATION FIX

A real controlled test exposed a verification issue.

Naukri can show an existing application using:

```
<span id="already-applied">Applied</span>
```

The old verification logic did not inspect this type of element.

The runner was updated to detect visible:

```
#already-applied
.already-applied
```

with exact "Applied" text.

The browser-side pre-click logic was also updated.

This prevents unnecessary reapplication.

A controlled Ecolab test confirmed:

* Existing Applied state detected
* Apply click was NOT performed
* Result recorded as `APPLIED / already-applied`
* It did NOT count toward the successful quota
* Job became permanently excluded

An earlier incorrect FAILED/unverified record remains in development history.

---

# 34. REAL VERIFIED APPLICATION TEST

A controlled one-job live test was performed.

Job:

```
Data Analyst
Leaz Edutech
Bengaluru
```

Job ID:

```
190626020642
```

Result:

* Apply clicked once
* Browser reported application confirmation
* Node independently reloaded the job
* Naukri showed Applied
* Ledger recorded:

  APPLIED | verified: Applied on reload

The application counted toward the successful quota.

At that time:

```
Today: 1 / 50
Run test: 1 successful application
```

The job became permanently excluded.

No Chrome/runner process remained afterward.

---

# 35. PAGINATION / RESUME FIX COMPLETED

Naukri pagination had several problems:

* Search state reset after restart
* Fruitless pages could cause unnecessary restarts
* Naukri Next navigation can change URL without a normal page-load event
* Injection throttling could interfere with later searches
* Restart could return to page 1

The Naukri runner was updated so that:

* Search/page state survives session restart
* In-page navigation is detected
* New result pages are reinjected
* Page advancement counts as progress
* Current URL is retained
* Restart resumes current results page
* Search index is retained
* Searches continue after one search is exhausted
* Existing stuck-browser restart protection remains

This behavior is Naukri-only.

---

# 36. PAGINATION TEST RESULTS

Testing confirmed:

* Page 1 → page 2 → page 3
* Different job cards were reached
* Search 1 → search 2 → search 3
* Forced restart while on page 3 resumed page 3 rather than page 1
* Normal page movement did not trigger unnecessary browser restarts
* No real applications were made during pagination testing

Minor known behavior:

1. After "No more pages", the next search may still wait up to approximately 45 seconds.
2. The 1.5 second post-navigation wait could theoretically encounter unusually slow page loading.

These are not currently blockers.

---

# 37. CURRENT NAUKRI ENGINE CAPABILITIES

The current engine has proven:

* Direct application
* Existing-application detection
* Independent application verification
* Persistent application ledger
* Successful application counting
* Permanent APPLIED/SKIPPED exclusion
* Retryable FAILED handling
* 10/run and 50/day limits
* Pagination
* Resume after browser restart
* Dry-run protection
* Browser show/hide behavior
* Existing Naukri question-answer infrastructure

---

# 38. CURRENT PRODUCT SCOPE

## BUILD NOW

1. Desktop JobPilot application
2. Dashboard
3. Setup
4. Running page
5. Applications
6. Reports
7. Job Details
8. Settings
9. Persistent configuration
10. Real-time status/events
11. Pause
12. Resume
13. Stop
14. Browser visibility controls
15. Dry Run
16. Controlled Test Mode
17. Explicit Live Mode
18. Resume/profile extraction
19. AI job matching
20. AI application-question answering
21. Automatic form filling
22. Detailed skip/intervention recording
23. Permanent detailed history

---

# 39. DO NOT BUILD YET

Do NOT currently add:

* Indeed
* Automatic scheduling
* Goku/Dragon Ball animations
* External company-site auto-apply
* Unnecessary major refactors
* Unnecessary changes to the proven Naukri application engine

---

# 40. IMPORTANT DEVELOPMENT RULE

The existing Naukri application engine has already been tested.

When adding the desktop application/UI:

* Keep application logic intact.
* Keep ledger semantics intact.
* Keep verification intact.
* Keep pagination intact.
* Keep resume behavior intact.
* Add UI/status integration around the engine.
* Avoid rewriting working functionality unless required.

---

# 41. FUTURE AI IMPROVEMENT LOOP

One of the most important long-term ideas is that skipped/intervention data should help us improve JobPilot.

Example:

```
100 applications attempted

70 successful
10 already applied
15 skipped
5 failed
```

Then inspect skipped:

```
7 custom questions
4 CAPTCHA
2 unsupported forms
2 missing user information
```

Future development can target the largest blockers.

The goal is for JobPilot to become better at completing applications over time without requiring the user to manually build an answer bank.

---

# 42. PROPOSED HIGH-LEVEL ARCHITECTURE

```
JOBPILOT DESKTOP APP
        |
        +-------------------------------+
        |               |               |
    DASHBOARD         SETUP           REPORTS
        |               |               |
        +---------------+---------------+
                        |
                 JOBPILOT CORE
                        |
         +--------------+--------------+
         |                             |
     AI SERVICES                APPLICATION ENGINE
         |                             |
  Resume/Profile                 Naukri Engine
  Job Matching                       |
  Question AI                        |
         |                           |
         +-------------+-------------+
                       |
                Persistent History
                       |
            +----------+----------+
            |          |          |
          APPLIED    SKIPPED    FAILED
```

Future:

```
                JOBPILOT CORE
                       |
          +------------+------------+
          |                         |
        Naukri                   Indeed
          |                         |
    Separate data             Separate data
    Separate engine           Separate engine
```

---

# 43. NEXT PLANNING STEP

Before implementation of the desktop application, finalize:

1. Exact navigation
2. Exact Setup fields
3. Dashboard layout
4. Running page
5. Applications table
6. Reports
7. Job Details
8. AI matching behavior
9. AI question-answering rules
10. Human-intervention categories
11. Pause/resume behavior
12. Dry-run/test/live behavior
13. Configuration architecture
14. Communication between desktop app and Naukri engine

Only after these are finalized should Claude/Codex receive the implementation specification.

---

# 44. CURRENT OVERALL STATE

The project is NOT starting from zero.

The Naukri automation engine already has a working foundation.

The major remaining work is to turn it into a proper JobPilot desktop application and add:

* User-friendly Setup
* Resume/profile extraction
* AI job matching
* AI-generated application answers
* Automatic answer/form filling
* Real-time status dashboard
* Running-process view
* Application history
* Reports
* Job Details
* Pause/resume controls
* Safe testing modes
* Detailed intervention records

The existing Naukri engine should remain the foundation.

The desktop app should be built around it rather than replacing it.

---

# 45. CORE PRODUCT IDEA

The final development direction is:

```
USER
  |
  | Resume + preferences
  ↓
JOBPILOT
  |
  | AI understands user
  ↓
SEARCH JOBS
  |
  ↓
AI MATCH
  |
  ↓
SUITABLE JOB
  |
  ↓
APPLICATION
  |
  +--> AI generates truthful answers
  |
  +--> AI fills supported fields
  |
  +--> Human intervention required
  |        |
  |        ↓
  |      SKIP + RECORD WHY
  |
  ↓
SUBMIT
  |
  ↓
INDEPENDENT VERIFICATION
  |
  ↓
VERIFIED
  |
  ↓
PERMANENT HISTORY
```

The user should be able to see what JobPilot is doing at every stage and later inspect exactly what happened to every job.
