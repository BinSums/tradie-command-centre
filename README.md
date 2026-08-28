# Command Centre for trades and landscaping

One private dashboard for a small trades business. It reads Xero and your Tradify exports,
and every morning it tells you the one thing worth acting on: work you finished but never
invoiced, an invoice that just tipped overdue, a quote going cold.

It runs in **your** Claude account and deploys to **your** Cloudflare account. Your
financials never pass through anyone else's infrastructure.

## What you need

- Node.js 20 or newer
- A Cloudflare account (the free tier is enough; this costs a few dollars a month at most)
- Xero, connected to Claude under Settings, then Connectors
- Tradify, for the CSV exports

## Install

```
/tradie-cc:setup
```

That creates the database, deploys the dashboard, sets the passwords and schedules the
routines. It takes about fifteen minutes and asks you four questions.

## What you get

**A dashboard** on any browser or phone home screen, behind a password you choose. It shows
what needs your attention, the numbers that matter, and a shared to-do list.

**A morning brief**, weekdays before you start. One card, thirty seconds to read.

**A cash and debtors watch**, Mondays. Not a list of overdue invoices: the two or three
genuinely worth a phone call, and why those ones.

**A jobs and quotes pipeline**, Mondays. Finished-but-not-invoiced work, quotes going cold,
and what the next month actually looks like.

## The one thing that will break it

Tradify has no API, so the jobs and quotes routine reads a CSV you export by hand into
`~/.command-centre/imports/`. If you stop doing that, the jobs numbers go stale rather than
going blank. Every card says how old that export is, so you will see it happen, but the
habit is on you. Xero is a live connection and needs nothing.

## Asking it for things

Anything you want it to notice, say in plain English to Claude. It goes into a queue and
the next scheduled run picks it up, acts on it, and reports back on the card.
