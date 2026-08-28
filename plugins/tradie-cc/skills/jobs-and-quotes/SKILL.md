---
name: jobs-and-quotes
description: Weekly jobs and quotes pipeline for a trades or landscaping business, built from Tradify CSV exports and the quoting spreadsheet. Use when the owner says "jobs", "quotes", "pipeline", "what's booked", "quote follow-ups", "work in progress", or on the scheduled Monday run. Reads the exports, finds the work that is stalling, and publishes a Jobs tab.
---

# Jobs and quotes

Tradify has no API. This routine reads what the office exports by hand, which makes the
freshness of that export the single biggest risk in the whole system. Treat it as such.

Load `posting-to-the-command-centre` first, and work the queue before anything else.

## Read the exports

Look in `~/.command-centre/imports/` for the most recent files. Tradify names exports by
type, so match on content rather than an exact filename, which changes between versions.
Expect columns for job number, customer, description, status, value and dates.

Three different exports may turn up, and they are not interchangeable:

- The **Jobs** export (Jobs page, Options, Export Jobs to File) carries status and dates.
- The **Quotes** export (Quotes page, Export icon) carries quote value and state.
- The **Job Financial Report** (Reports page, Download CSV File) carries job value and cost,
  which the plain Jobs export does not. If this one is present, prefer it for anything
  involving money, and say on the card which export a figure came from.

Archive what you read so the next run can diff against it:

```bash
post /ingest-import /tmp/import.json    # {"source":"tradify-jobs","filename":"...","csv":"...","period":"..."}
```

Then `get /api/imports?source=tradify-jobs&latest=1` gives you last week's, and the
difference between the two is where every interesting finding actually lives.

**Check the age of the export first, before reading a single number.** If it is more than
7 days old, post a `warn` card saying exactly how old it is and what that means, put a note
in area `ops` asking for a fresh export, and report last week's figures explicitly labelled
as last week's. Do not silently present stale numbers as current. This will happen: the
office gets busy and the export is the first habit to slip.

If the quoting spreadsheet is also in that folder, read it for quotes that never made it
into Tradify. Quotes living only in Excel are the ones most likely to go cold, because
nothing is tracking them.

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
