---
name: routine-audit
description: Nightly health check on every scheduled routine. Finds silently denied calls, dead connectors, stale exports, schedule clashes and runs that produced nothing, then repairs what is safely repairable. Use when the owner says "why did nothing run", "routine health", "audit the routines", "check the schedules", or on the scheduled nightly run.
---

# Routine audit

The routines run unattended in `dontAsk` mode, which means **a call outside the allowlist is
denied silently and the run keeps going without it**. Nothing tells anybody. This is the only
thing that notices, which is why it is not optional and why turning it off eventually turns
the whole system into a dashboard of confident half-truths.

Load `standing-rules` first. This skill is not exempt from the rules it enforces: the audits
that lost their own calls to denials are the reason those rules are written down.

## 1. Work the queue

```bash
bash ~/.command-centre/bin/cc.sh get /api/assistant-queue
```

## 2. Scan for silent losses

One call. Read the output off the screen.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-denials.py" 3
```

It reports denied calls grouped **by routine**, repeated tool errors, and which routines ran
at all. Grouping by routine is the point: a denial count with no owner never gets fixed,
because nobody knows what to repair.

Read it like this:

- **A denial inside a ROUTINE is silent data loss.** Fix it this run.
- **A denial in an INTERACTIVE session** cost somebody one keystroke. Note it, do not chase it.
- **Repeated tool errors** are usually a connector that has dropped or a token that expired.
- **A routine that does not appear at all** did not run. That is a bigger finding than any
  denial, and the most common cause is the machine being asleep when it was due.

## 3. Fix what is safely fixable

**A denied Bash call** is nearly always one of the shapes `standing-rules` warns about: a
compound command, a bare `>` redirect, `sed -n` on a path, or an inline `source`. Repair the
routine's own prompt so it uses the shape that works. That is a structural fix and it holds.

**A denied Edit or Write** means the routine is editing a file directly. Rewrite that step to
go through a `python3` heredoc. Do not "fix" it by adding another path rule to the allowlist:
the measurement in `standing-rules` shows those rules are not reliably honoured, so a new rule
looks like a fix and changes nothing.

**A genuinely missing tool** (a command the routines need and nobody allowed) is the one case
where the allowlist is the right answer:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py"
```

Re-running it is safe. It adds only what is missing and backs up first.

**A dead connector** is not yours to fix. Xero authorisation expires and only the owner can
reconnect it. Put it on the card as blocked on them, with the exact path: Settings, then
Connectors, then Xero, then Connect.

## 4. Check the exports have not gone quiet

```bash
bash ~/.command-centre/bin/cc.sh get /api/import-status
```

If the newest upload is more than 7 days old, the jobs and quotes routine is running on stale
data. Raise it as a to-do naming the person who does the export, not a vague note. If it is
more than 21 days old, the habit has stopped rather than slipped: say that plainly, because
the fix is a conversation, not a reminder.

## 4b. If the Tradify fetch is scheduled, check it is still working

The browser fetch is the most brittle thing here by design, and its usual failure is not a bug:
the Tradify session expired and somebody has to sign in once in Chrome.

Look for recent `fetch-from-tradify` cards. If the last few are `warn`:

- **Session expired**: not yours to fix and not a fault. Put it on the card as blocked on them,
  with the exact fix: open Chrome, sign in to Tradify, tick remember me.
- **Browser not connected**: Chrome was closed or the extension is disabled.
- **Failed three runs running**: say plainly that it is worth going back to uploading by hand
  for now. A weekly minute beats a number nobody trusts, and the upload box always works.

Never try to sign in to Tradify, and never go looking for stored credentials to do it with.

## 5. Check the dashboard is actually being fed

```bash
bash ~/.command-centre/bin/cc.sh get /api/runs?days=7
```

Every routine that is scheduled should appear. One that is scheduled but has no card for
several days is failing before it posts, and its transcript is where the reason is.

## 6. Check the schedules do not collide

Read the scheduled tasks and compare their fire times. Two routines starting in the same
minute will queue behind each other and one may miss its window entirely. Shift by minutes,
never by hours, and **never change how often a routine fires** without being asked.

## 7. Post the card

`skill_id` `routine-audit`. Status honestly:

- `ok` nothing lost, everything ran
- `warn` denials found and repaired, or an export going stale
- `alert` a routine did not run at all, or a connector is down and needs the owner

Say what was repaired, in plain words, and list separately anything blocked on the owner. If
this audit found nothing, say so in one line. That is a good night and it should read like one.

## What this audit must never do

- Turn off `dontAsk` mode. It exists so the runs do not stall waiting for approval.
- Change how often a routine fires.
- Mark a to-do done that it merely attempted. Closing something unverified is worse than
  leaving it open, because the job leaves the list and the work does not happen.
- Invent a result. If the scan could not run, say that.
