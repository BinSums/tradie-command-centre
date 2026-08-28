# Command Centre for trades and landscaping

One private dashboard for a small trades business. It reads Xero and your Tradify exports, and
every morning it tells you the one thing worth acting on: work you finished but never invoiced,
an invoice that just tipped overdue, a quote going cold.

It runs in **your** Claude account and deploys to **your** Cloudflare account. Your financials
never pass through anyone else's infrastructure.

## Install

Never done anything like this before? Follow **Start Here**
(`plugins/tradie-cc/docs/start-here.html`). It assumes you have no software installed and
nobody helping, and takes about an hour.

If you already have Claude and Node.js:

```
/plugin marketplace add BinSums/tradie-command-centre
/plugin install tradie-cc@sims-business-tools
/tradie-cc:setup
```

Setup finds anything missing, tells you how to fix it in plain words, then creates the
database, deploys the dashboard, sets the passwords, schedules the routines, and proves it
works by reading two real figures off your first report before it finishes.

If anything ever looks wrong afterwards:

```
/tradie-cc:check
```

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

Tradify has no API, so once a week somebody exports a CSV and drags it onto the dashboard. It
works out which export it is on its own. If you stop, the jobs numbers go stale rather than
going blank. The Home tab shows each export's age in green, amber then red, and the routine
stops treating it as current after a week. Xero is a live connection and needs nothing.

## Asking it for things

Anything you want it to watch, say in plain English to Claude. It goes on a queue, and the next
run picks it up, acts on it, and reports back on the card.

## Try before you install

The whole dashboard runs on a laptop with sample data and no accounts at all:

```bash
bash plugins/tradie-cc/scripts/demo.sh
```

Then open http://127.0.0.1:8799 with the password `demo`.
