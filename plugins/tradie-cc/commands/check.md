---
description: Check the Command Centre is working properly and fix what can be fixed. Run this if a report has not appeared, a number looks wrong, or anything seems off.
---

# Check the Command Centre

Somebody typed this because something looks wrong, and there is nobody technical with them.
Your job is to find out what, fix what you safely can, and explain the rest in plain words.

**Do not narrate the diagnosis.** They do not want to watch you check nine things. Do the work,
then give them one short answer: what is wrong, whether you fixed it, and what they need to do.
If everything is fine, say so in one line and stop.

Load `standing-rules` first.

## Run through all of these before saying anything

**1. Is it configured at all?**

```bash
ls ~/.command-centre/env ~/.command-centre/bin/cc.sh
```

If those are missing, setup never finished. Tell them to run `/tradie-cc:setup` and stop here.

**2. Is the dashboard up and reachable?**

```bash
bash ~/.command-centre/bin/cc.sh get /api/runs?days=7
```

- A list of runs: the dashboard is fine and the routines are posting.
- `bad token`: the key in `~/.command-centre/env` does not match the deployed one. Fixable, but
  it needs `npx wrangler secret put INGEST_SECRET` and the same value written into `env`. Do it.
- `Setup incomplete: ... is not set`: a password never got set on the server. Set it.
- Nothing at all / connection error: the dashboard is not deployed, or their internet is down.
  Ask which, then redeploy from `~/.command-centre/worker` if needed.

**3. Has anything actually run?**

Compare the runs list against the scheduled tasks. A routine that is scheduled but has no card
for several days is the most common real fault, and the most common cause is the computer being
asleep or Claude being closed at the scheduled time. Ask: "Is this computer usually on and is
Claude usually open around 7am?" If not, that is the whole answer, and the fix is a conversation
about which machine this should live on, not a technical repair.

**4. Was anything refused?**

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-denials.py" 5
```

Denials inside a routine are silent losses. Repair the routine's own prompt so it uses shapes
that work: a python heredoc instead of Edit or Write, one simple command per call. If a genuinely
needed tool is missing from the allowlist, re-run the permission installer. Never "fix" a denied
Edit or Write by adding another path rule.

**5. Is Xero still connected?**

Ask for their organisation name through the Xero tools. If it fails, the authorisation has
expired. **You cannot fix this and neither can I.** Tell them: Settings, then Connectors, then
Xero, then Connect, sign in and approve. Then offer to re-run the check.

If the Xero tools work but recent cards have no Xero figures on them, the connector prefix in
their allowlist is wrong or stale. Re-discover the real tool names and re-run:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py" --mcp "mcp__<their-prefix>__*"
```

**6. Are the exports still coming?**

```bash
bash ~/.command-centre/bin/cc.sh get /api/import-status
```

Nothing there at all: the upload habit never started, and the jobs and quotes half has never
worked. Newest upload more than 7 days old: it has slipped. More than 21 days: it has stopped.
Say which of those three it is, plainly, and walk them through the export again if they want.

**7. Is the dashboard password still working?**

Ask them. If they cannot sign in, reset it with `npx wrangler secret put DASH_PASSWORD` and
have them type a new one. Do not ask what the old one was.

## Then give them the answer

One short message. Something like:

> Everything is running. The morning brief has posted every weekday this week and Xero is
> connected. One thing: your last Tradify export was 11 days ago, so the jobs and quotes numbers
> are from the 17th. Export a fresh one when you get a minute and it will catch up on Monday.

Say what you repaired, list anything that needs them, and nothing else. If you found nothing:

> Checked everything and it is all working normally. Nothing for you to do.

## What you must never do here

- Turn off the permission mode, or change how often a routine fires, to make a symptom go away.
- Mark anything on their to-do list as done.
- Delete or redeploy anything without telling them what you are about to do first.
- Guess at a number. If a source is unavailable, say which one.
