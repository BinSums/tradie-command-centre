---
name: jobs-and-quotes
description: Weekly jobs and quotes pipeline for a trades or landscaping business, built from Tradify CSV exports and the quoting spreadsheet. Use when the owner says "jobs", "quotes", "pipeline", "what's booked", "quote follow-ups", "work in progress", or on the scheduled Monday run. Reads the exports, finds the work that is stalling, and publishes a Jobs tab.
---

# Jobs and quotes

Tradify has no API. This routine reads what the office exports by hand, which makes the
freshness of that export the single biggest risk in the whole system. Treat it as such.

Load `posting-to-the-command-centre` first, and work the queue before anything else.

## Read the exports

They arrive by upload. Somebody in the office drops the CSV on the dashboard's Home tab and
it is stored, dated and typed automatically. **Do not go looking on disk**: this routine may be
running in the cloud, where there is no local folder at all.

```bash
bash ~/.command-centre/bin/cc.sh get /api/import-status
```

That gives the newest upload per kind, which is the first thing to read. Then pull the one you
want, and the one before it, since the interesting finding is almost always the difference
between two weeks rather than the state of one:

```bash
bash ~/.command-centre/bin/cc.sh get "/api/imports?source=tradify-jobs&latest=1"
bash ~/.command-centre/bin/cc.sh get "/api/imports?source=tradify-quotes&latest=1"
bash ~/.command-centre/bin/cc.sh get /api/imports          # the list, to find last week's
```

Three kinds may be present and they are not interchangeable:

- `tradify-jobs` carries status and dates.
- `tradify-quotes` carries quote value and state.
- `tradify-job-financials` carries job value and cost, which the plain Jobs export does not. If
  this is present, prefer it for anything involving money, and say on the card which export a
  figure came from.

**Check the age before reading a single number.** If the newest upload is more than 7 days old,
post a `warn` card saying exactly how old it is, put a note in area `ops` asking for a fresh
upload, and report the figures explicitly labelled as that date's. Do not present stale numbers
as current. This will happen: the office gets busy and the upload is the first habit to slip.

If nothing has ever been uploaded, say so plainly and post an `info` card. That is not a fault,
it is a setup step nobody has done yet, and the fix is one drag onto the dashboard.

## What to look for

**Finished but not invoiced.** Jobs marked complete with no invoice raised. Cross-check
against Xero. This is the most valuable thing this routine finds and it should be first.

**Quotes going cold.** Sent more than 14 days ago, not accepted, not rejected, no follow-up.
Conversion falls off a cliff after two weeks. List them by value.

**Jobs stalled.** In progress, no movement between this export and last, and older than
their usual turnaround. Work out the usual turnaround from the data rather than assuming a
number: a landscaper's retaining wall and their mow-and-tidy are not the same job.

**The pipeline.** Total value quoted and not yet decided, against work booked. This is the
number that tells the owner whether next month is full, and it is the one they cannot get
from Tradify's own reporting.

## What to post

A card, `skill_id` `jobs-and-quotes`, with the export's age stated plainly on it.

Metrics: `jobs_active`, `quotes_out`, `quotes_value`, and `jobs_uninvoiced_value` when you
can work it out. Null, not zero, for anything the export did not cover.

Notes, area `quotes` or `jobs`. Name the customer and the amount every time.

A published page at slug `jobs`, titled `Jobs`: a table of open jobs and one of live quotes,
each sorted by value, with the stalled and cold ones marked. Plain light HTML with inline
styles. This is the tab the owner opens when they want the detail behind the card.

To-dos for quote follow-ups worth making this week, titled `Follow up <customer> quote
<number>` so the dedupe holds across runs.
