# __BUSINESS_NAME__

Claude works on this business through the Command Centre. Read this before any scheduled run.

## What is where

- **Dashboard**: __DASHBOARD_URL__
- **Config and helper**: `~/.command-centre/` (the `env` file holds the address and token)
- **Tradify exports land in**: `~/.command-centre/imports/`
- **Post to the dashboard with**: `bash ~/.command-centre/bin/cc.sh`

## Standing rules for every run

Load the `standing-rules` skill first. In short:

- **If something needs fixing, fix it in that run** and say what was repaired. Do not hand
  back a list. Escalate only what genuinely needs __OWNER_NAME__: a password, spending money,
  contacting a customer or supplier, deleting real data, or a commercial judgement call.
- **Never use `Edit` or `Write` on a file outside `/tmp`.** Write changes through a `python3`
  heredoc. Path rules for those tools are not reliably honoured in `dontAsk` mode, so a run
  that uses them loses the work silently.
- **One simple command per Bash call.** Compounds are denied whole.
- **Never invent a number.** If a source was unavailable, name it on the card and set the
  status to `warn`. A missing number is null, never zero.
- **Work the queue first**, every run, before anything else.

## About this business

Fill this in. The routines read it, and it is the difference between advice that fits and
advice that reads like it came off the internet.

- What the business does, and who its customers are:
- Busy season and quiet season:
- Normal turnaround for a typical job:
- Payment terms offered, and who is usually slow:
- Anything a routine should never chase or flag:
