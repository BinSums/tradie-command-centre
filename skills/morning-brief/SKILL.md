---
name: morning-brief
description: Daily morning brief for a trades or landscaping business. Use when the owner says "morning brief", "how are we going", "what should I know today", or on the scheduled weekday run. Pulls the cash position and this week's work, and posts one short card saying the single thing worth acting on today.
---

# Morning brief

One card, read on a phone, before the first job. If it takes longer than thirty seconds to
read, it is too long and will stop being read within a fortnight.

Load `posting-to-the-command-centre` first, and work the queue before anything else.

## What to pull

- **Xero**: cash position, receivables total, anything that fell overdue since yesterday,
  invoices raised and payments received yesterday.
- **The latest Tradify export** in `~/.command-centre/imports/`, if there is one. Jobs
  booked this week, jobs finished but not yet invoiced, quotes sent and not yet accepted.
- **The to-do list**: `get /api/todos`. What is still open, and what has been open too long.

## The one thing

The whole point of the brief is the first line. Work out what actually changed since
yesterday and lead with it. In rough order of how much it usually matters:

1. Work finished but not invoiced. This is the most common way a trades business loses
   money, and it is invisible in both Xero and a jobs list on their own.
2. A large invoice that just tipped overdue.
3. Cash that will not cover known bills in the next fortnight.
4. Quotes going cold, which is the leading indicator of a thin month in six weeks.
5. Nothing. Say so. "Quiet one, nothing needs you" is a legitimate and valuable brief, and
   posting it honestly is what makes the alarming ones believed.

## What to post

A card, `skill_id` `morning-brief`. `summary_html` is the one thing plus at most three
supporting lines. `detail_html` carries the fuller picture for anyone who taps in.

Metrics: `cash_at_bank`, `revenue_mtd`, and `jobs_active` and `quotes_out` if a Tradify
export is available.

**Say how old the Tradify data is, every time.** It is a manual export, so it goes stale
silently. "Jobs data from Monday's export, 3 days old" on the card is the difference
between a number the owner trusts and a number that quietly misleads them. If the export
is more than 7 days old, set status `warn` and put a note in area `ops` asking for a fresh
one rather than reporting the stale figures as current.
