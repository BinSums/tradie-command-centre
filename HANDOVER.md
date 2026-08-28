# Handing this to a client

Notes for me. The client gets one link and does the rest themselves.

## The whole handoff

Send them the Start Here guide. That is it. It takes them from owning no software to a
working dashboard without me being present, present in the room, or on the phone.

`plugins/tradie-cc/docs/start-here.html`, also published as an artifact.

They end up typing three lines:

```
/plugin marketplace add BinSums/tradie-command-centre
/plugin install tradie-cc@sims-business-tools
/tradie-cc:setup
```

Everything after that is a conversation between them and Claude. `commands/setup.md` is
written on the assumption that the person reading it has never used a terminal and has nobody
helping, so it finds every missing prerequisite first, explains each in plain words, and
verifies its own work at the end by reading two real Xero figures back to them.

If anything ever looks wrong afterwards they type `/tradie-cc:check`, which diagnoses,
repairs what it can, and reports the rest in plain words.

## HARD PREREQUISITE: the repo must be public on GitHub

**Self-service does not work until this is done.** The first line of the guide is
`/plugin marketplace add BinSums/tradie-command-centre`, and there is currently no remote.
There is nothing secret in the repo: every credential is created during their setup and lives
in their Cloudflare account and their `~/.command-centre/env`.

A local folder path works for an install I attend, but not for a handoff.

## Still not rehearsed

`/tradie-cc:setup` has never been run against a real Cloudflare account. In an attended
install that is a risk. **In an unattended handoff it is the whole product**, because there is
nobody to catch it when it goes wrong. Rehearse it end to end on my own Cloudflare, then delete
what it made, before sending the guide to anybody.

## What setup actually does to their machine

Worth knowing, because they will ask and because it is what I am responsible for:

| Step | Touches | Reversible? |
| --- | --- | --- |
| Creates a D1 database | Their Cloudflare account | Yes, delete it |
| Deploys a Worker | Their Cloudflare account | Yes, delete it |
| Sets three secrets | Their Cloudflare account | Yes |
| Writes `~/.command-centre/` | Their machine | Yes, delete the folder |
| **Merges an allowlist into `~/.claude/settings.json`** | **Their machine** | Yes, it backs up first |
| Writes a `CLAUDE.md` | Their project folder | Yes |
| Creates scheduled tasks | Their machine | Yes, delete them |

The settings merge is the only one that changes something they already had. It never removes or
reorders anything, backs up with a timestamp, and re-parses what it wrote before replacing the
file. Show them the `--dry-run` output before running it for real. It costs thirty seconds and
it is the difference between them trusting the install and not.

## The three things that make it run itself

1. **`dontAsk` permission mode plus an allowlist** (`settings/permissions.json`, merged by
   `scripts/install-permissions.py`). No approval prompt blocks a 7am run.
2. **Scheduled tasks**, created in step 8 of setup.
3. **The nightly routine audit**, which is the only thing that notices a run silently losing
   calls. Schedule it even if they want nothing else.

## The trap, stated once so I do not forget it

`dontAsk` means an un-allowlisted call is **denied silently**. Measured on my own machine on
28 Aug 2026: 42 denials in two days across four routines, and every denied `Edit` and `Write` was
to a path an allow rule already covered. Path rules for those two tools are not reliable in this
mode.

What that actually costs, checked rather than assumed: the model is told to try another tool and
does, so 13 of 14 denied writes recovered via a python script and the change landed. The cost was
a wasted turn each time. 1 of 14 did not recover and was lost with nothing to say so. Treat it as
an efficiency problem with an occasional correctness tail, not as routine data loss. The tail is
what the nightly audit is for.

That is why `standing-rules` forbids `Edit` and `Write` outside `/tmp` and makes every file
change go through a `python3` heredoc, and why the audit must never "fix" a denial by adding
another path rule. It would look like a fix and change nothing.

## Xero is the one thing that cannot be prepared in advance

The connector's server name is generated per user, so the allowlist entry cannot be shipped. The
setup discovers the real prefix and passes it in with `--mcp`. Get it wrong and every Xero call
in every routine is denied silently, and the cards report confidently on half the business.

Always run one routine by hand before leaving and check the card carries real Xero numbers.

## Before I hand it to the next one

- [ ] Repo public on GitHub, or the folder copied to their machine
- [ ] Confirm their Tradify plan actually exports (all plans do, but confirm)
- [ ] Ask who does the weekly export, by name, and put them on the card
- [ ] Fill in the "About this business" section of `CLAUDE.md` with them, not for them
- [ ] Run the morning brief by hand and check the Xero numbers are real
- [ ] Run `scan-denials.py 1` and fix anything it found while still sitting there
