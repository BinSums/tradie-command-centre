---
description: Set up the Command Centre. Deploys the dashboard to your own Cloudflare account, connects Xero, sets the permissions so routines run unattended, and schedules them.
---

# Set up the Command Centre

You are walking a business owner or their office manager through a one-off install. They are
not a developer. Explain each step in one plain sentence before running it, and never print a
secret into the chat.

Everything deploys into **their** Cloudflare account and **their** Xero. Say that out loud at
the start, because it is the first thing anyone asks.

Work through this in order. Do not skip step 6 or step 7: without them the routines will run
but quietly lose work, which is worse than not running.

## Step 0: check the prerequisites

Stop if any of these is missing.

- **Node.js 20+.** `node --version`. If missing, send them to nodejs.org/en/download.
- **A Cloudflare account.** `npx wrangler whoami` shows who is signed in. If nobody is,
  `npx wrangler login` opens a browser.
- **Xero connected to Claude.** They do this themselves: Settings, then Connectors, then Xero,
  then Connect, sign in and approve. Verify by asking for their organisation name through the
  Xero tools. **If the Xero tools are not available, stop here.** The routines have nothing to
  read without it and installing the rest would produce empty cards.

## Step 1: ask four things

Ask in one message. Take sensible defaults if they do not care.

1. Business name, as it should appear at the top of the dashboard.
2. Timezone (default `Australia/Sydney`).
3. Currency (default `AUD`).
4. A password for the dashboard. **Do not suggest one and do not echo it back.** Tell them to
   pick one and have it ready to type into a prompt.

## Step 2: create the database

```bash
cd "${CLAUDE_PLUGIN_ROOT}/worker"
npx wrangler d1 create <business-slug>-cc-db
```

That prints a `database_id`. Copy `wrangler.toml.template` to `wrangler.toml` and fill in
`__WORKER_NAME__`, `__BUSINESS_NAME__`, `__TIMEZONE__`, `__CURRENCY__`, `__DB_NAME__` and
`__DB_ID__`. Write it with a python heredoc, not the Write tool. Then build the tables:

```bash
npx wrangler d1 execute <business-slug>-cc-db --remote --file=schema.sql
```

`--remote` matters. Without it you build the tables on their laptop and the deployed dashboard
talks to an empty database.

## Step 3: set the three secrets

Generate the two random ones yourself and never show them:

```bash
openssl rand -base64 32
```

`wrangler secret put` prompts for the value, so nothing lands in shell history:

```bash
npx wrangler secret put DASH_PASSWORD    # they type their own password
npx wrangler secret put COOKIE_SECRET    # paste a generated random string
npx wrangler secret put INGEST_SECRET    # paste a second, different one
```

## Step 4: deploy

```bash
npx wrangler deploy
```

Open the URL it prints, sign in, and confirm the dashboard loads. It will be empty. That is
correct: nothing has run yet.

## Step 5: install the helper at a stable path

The routines call the helper by absolute path, and that path has to be stable because the
permission allowlist names it. The plugin directory is not stable: it changes when the plugin
updates. So copy it out.

```bash
mkdir -p ~/.command-centre/bin ~/.command-centre/imports
cp "${CLAUDE_PLUGIN_ROOT}/scripts/cc.sh" ~/.command-centre/bin/cc.sh
chmod +x ~/.command-centre/bin/cc.sh
```

Write `~/.command-centre/env` with mode 600, using a python heredoc:

```
CC_URL=https://<the deployed url>
CC_TOKEN=<the INGEST_SECRET from step 3>
```

Then prove the loop works before going any further:

```bash
bash ~/.command-centre/bin/cc.sh postj /ingest '{"skill_id":"setup","title":"Setup complete","status":"ok","summary_html":"<p>The Command Centre is live and the routines can post to it.</p>","detail_html":"<p>Posted by the setup command to prove the connection works end to end.</p>"}'
```

Refresh the Reports tab. If the card is there, the plumbing is done. If it is not, the token in
`env` does not match the deployed `INGEST_SECRET`. Set it again rather than guessing.

## Step 6: permissions, so the routines run unattended

**This is the step that decides whether any of it works at 7am.**

The routines run with `defaultMode: "dontAsk"` so no approval prompt blocks a run nobody is
watching. The trade is that any call outside the allowlist is **denied silently** and the run
carries on having lost that step.

Xero is the part that cannot be hardcoded: its connector server name is generated per user. So
discover the real tool names first. List the available tools, find the Xero ones, and note the
prefix, which looks like `mcp__<something>__get_profit_and_loss`. Take everything up to and
including the second pair of underscores and add `*`.

Then merge the allowlist into their settings. Dry run first and show them what it will add:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py" --dry-run --mcp "mcp__<their-xero-prefix>__*"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py" --mcp "mcp__<their-xero-prefix>__*"
```

It never overwrites. It adds what is missing, backs up first, and re-parses what it wrote.

**Get the Xero prefix wrong and every Xero call in every routine is denied silently**, and the
cards report confidently on half the business. If you are not certain you have the right prefix,
run a routine by hand and check the card has real Xero numbers on it before you leave.

## Step 7: write the project rules file

Copy `templates/CLAUDE.md` to the directory the routines will run from, filling in the business
name, the dashboard URL and the owner's name. Use a python heredoc.

This is what makes the runs behave the way they should when nobody is watching: fix rather than
report, escalate only what needs the owner, and never use `Edit` or `Write` outside `/tmp`.

Then walk them through the "About this business" section at the bottom and fill it in together.
Busy season, normal job turnaround, payment terms, who is always slow, and anything a routine
should never chase. Ten minutes here is the difference between advice that fits and advice that
reads like it came off the internet. Do not skip it because it is the boring part.

## Step 8: schedule the routines

Create these as scheduled tasks. Each prompt must be self-contained, because a scheduled run
starts fresh with no memory of this conversation: name the skill to load, the working directory,
and the fact that it must load `standing-rules` first.

| Routine | When | Cron |
| --- | --- | --- |
| Morning brief | Weekdays, early | `52 6 * * 1-5` |
| Cash and debtors | Mondays | `7 8 * * 1` |
| Jobs and quotes | Mondays | `33 8 * * 1` |
| **Routine audit** | **Nightly** | `41 4 * * *` |

Two things about those times. They are deliberately off the hour and off the half hour, because
everything scheduled at `0 9` in the world fires at the same instant. And they are spaced by
more than a few minutes so two routines never queue behind each other.

**Schedule the audit even if they only want one routine.** It is the only thing that notices a
run silently losing calls, and without it the failure mode is a dashboard that looks fine and is
quietly wrong.

Recommend starting with the morning brief plus the audit, and adding the other two after a
fortnight. One habit that sticks beats three that get ignored.

Tell them scheduled tasks run while the app is open, and that a task due while it was closed
runs at next launch. On a machine that sleeps overnight, a 4am audit fires in the morning.

## Step 9: the export habit

Tradify has no API, so the jobs and quotes routine reads a CSV somebody exports by hand. The two
exports sit behind different controls, so show them both once rather than describing one:

- **Jobs**: the Jobs page, filter or tick what they want (ticking nothing exports everything in
  the current tab), then **Options** in the top right, then **Export Jobs to File**.
- **Quotes**: the Quotes page, tick what they want, then the **Export icon**. There is no Options
  menu on this one.
- **Better still, if they will do it**: the **Reports** page has a *Job Financial Report*, which
  carries job values and costs the plain Jobs export does not. Download arrow, then Download CSV
  File.

Save them into `~/.command-centre/imports/`. Tell them plainly: **if they stop dropping the
export, the jobs numbers go stale rather than going blank.** Every card states the export's age
and the routine turns amber past seven days, but the habit is theirs.

## Step 10: run one by hand before you leave

Do not finish on a promise. Run the morning brief now, look at the card together, and confirm
the Xero numbers on it are real. Then run:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-denials.py" 1
```

If that run lost any calls, fix it now while you are still sitting there. This is the single
best predictor of whether the thing is still working in a month.

## Finally

Tell them the dashboard address, that it installs to a phone home screen from the browser share
menu, and that anything they want it to watch can be said to Claude in plain English, which the
queue picks up on the next run.
