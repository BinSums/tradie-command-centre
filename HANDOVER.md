# Handing this to a client

Notes for me, not for them. The client-facing version is `README.md` and the manual PDF.

## What they run

```
/plugin marketplace add bensims/tradie-command-centre
/plugin install tradie-command-centre@sims-business-tools
/tradie-cc:setup
```

Three lines. The first two need this repo to be **public on GitHub**, which is fine: there is
nothing secret in it. Every credential is created during setup and lives in their Cloudflare
account and their `~/.command-centre/env`, never in here.

If I am sitting with them and would rather not publish yet, the same thing works from a folder:

```
/plugin marketplace add /path/to/tradie-command-centre
/plugin install tradie-command-centre@sims-business-tools
```

A private repo also works but they need a GitHub account with access and `gh` authenticated,
which is friction for a landscaper. Public repo is the right answer.

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

`dontAsk` means an un-allowlisted call is **denied silently**. The run continues, the card still
posts, and the number is just missing. Measured on my own machine on 28 Aug 2026: 42 denials in
two days across four routines, and every denied `Edit` and `Write` was to a path an allow rule
already covered. Path rules for those two tools are not reliable in this mode.

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
