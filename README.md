# Command Centre for trades and landscaping

One private dashboard for a small trades business. It reads Xero and your Tradify exports, and
every morning it tells you the one thing worth acting on: work you finished but never invoiced,
an invoice that just tipped overdue, a quote going cold.

It runs in **your** Claude account and deploys to **your** Cloudflare account. Your financials
never pass through anyone else's infrastructure.

## Install

```
/plugin marketplace add bensims/tradie-command-centre
/plugin install tradie-command-centre@sims-business-tools
/tradie-cc:setup
```

Setup takes about twenty minutes and asks you four questions. It creates the database, deploys
the dashboard, sets the passwords, schedules the routines and walks you through the one habit
the system depends on.

## What you need

- Node.js 20 or newer
- A Cloudflare account (free tier covers it; a few dollars a month at most)
- Xero, connected under Settings, then Connectors
- Tradify, for the CSV exports

## What you get

**A dashboard** in any browser or on a phone home screen, behind a password you choose.

**A morning brief**, weekdays. One card, thirty seconds to read.

**A cash and debtors watch**, Mondays. Not a list of overdue invoices: the two or three
genuinely worth a phone call, and why those ones.

**A jobs and quotes pipeline**, Mondays. Finished-but-not-invoiced work, quotes going cold, and
what next month actually looks like.

**A nightly audit** that checks the other routines are still working properly and repairs them
when they are not. Leave this one on.

## The one thing that will break it

Tradify has no API, so the jobs and quotes routine reads a CSV you export by hand into
`~/.command-centre/imports/`. If you stop, the jobs numbers go stale rather than going blank.
Every card says how old that export is, and the routine stops treating it as current after a
week. Xero is a live connection and needs nothing.

## Asking it for things

Anything you want it to watch, say in plain English to Claude. It goes on a queue, and the next
run picks it up, acts on it, and reports back on the card.

## Try before you install

The whole dashboard runs on a laptop with sample data and no accounts at all:

```bash
bash plugins/tradie-command-centre/scripts/demo.sh
```

Then open http://127.0.0.1:8799 with the password `demo`.
