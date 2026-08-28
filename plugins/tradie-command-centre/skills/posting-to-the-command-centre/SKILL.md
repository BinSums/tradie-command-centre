---
name: posting-to-the-command-centre
description: How every routine posts its result to the Command Centre dashboard. Load this before writing or changing any routine that reports a number, a card, a recommendation or a to-do. Covers the cc.sh helper, the card format, metrics, notes, the to-do list and the assistant queue.
---

# Posting to the Command Centre

Every routine ends the same way: it posts what it found. A run that works out something
useful and does not post it may as well not have run.

## The helper

All traffic goes through `cc.sh`, which loads the URL and token itself so no secret ever
reaches a command line or the chat transcript.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/cc.sh" post /ingest /tmp/card.json
```

| Verb | What it does |
| --- | --- |
| `post <path> <file>` | POST from a file. The normal way to send a card. |
| `postj <path> '<json>'` | POST inline JSON. Short bodies only. |
| `get <path>` | GET, e.g. `/api/assistant-queue`. |

Build the JSON with Python's `json.dump` to a temp file, then post the file. Do not
hand-build JSON with string concatenation: one apostrophe in a customer name breaks it.

## Work the queue first

**Every run fetches the queue before doing anything else.**

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/cc.sh" get /api/assistant-queue
```

- kind `note`: context or a correction from the owner. Apply it to this run, and if it is
  durable, remember it. Mark done.
- kind `task`: do it if it fits this run or is quick. Otherwise surface it prominently in
  the card. Only mark done when it is actually done.

Mark done with `postj /api/assistant-queue/done '{"id":N}'`. Never leave an item unread: if
you cannot do it, say so on the card rather than silently skipping it.

## The card

```json
{
  "skill_id": "morning-brief",
  "title": "Morning brief",
  "status": "ok",
  "summary_html": "<p><b>One line that says the thing.</b></p><ul><li>...</li></ul>",
  "detail_html": "<the full run output>",
  "run_at": "2026-08-28T07:00:00+10:00"
}
```

- **skill_id**: a stable slug, the same every run, so history lines up. Check what already
  exists with `get /api/runs` before inventing one.
- **status**: `ok` green, `warn` amber, `alert` red, `info` grey. Pick honestly. A routine
  that reports `ok` on a bad week trains the owner to ignore it.
- **summary_html**: card-sized. One short `<p>`, then two to four `<li>`. No headings.
- **detail_html**: the FULL output, not a longer summary. This is where the whole report
  goes. It renders in a sandboxed frame, so inline styles are fine and scripts will not run.
- **run_at**: optional, defaults to now, which is almost always right. A time more than five
  minutes in the future is rejected and replaced, so a fake stamp only produces a card
  showing a time that has not happened.

One card per run. History is append-only, so nothing is ever overwritten. To correct a card,
post again with the same `run_at` and mark the title, e.g. "Morning brief (corrected)".

## Numbers

```bash
postj /ingest-metrics '{"metrics":[{"date":"2026-08-28","key":"cash_at_bank","value":48210}]}'
```

Upserted on (date, key), so re-running a day corrects rather than duplicates. **A missing
number is `null`, never `0`.** Zero means the business genuinely had zero; null means you
could not find out. Charting one as the other is how a dashboard starts lying.

A metric only gets a tile if it has a row in `metric_meta`. Adding a new key means adding
its label, unit (`money`, `count`, `percent`, `hours`, `days`) and whether up is good.

## Recommendations

```bash
postj /ingest-notes '{"date":"2026-08-28","notes":[{"area":"cash","severity":"do-now","title":"...","body":"...","metric":"..."}]}'
```

Replaced wholesale per (date, area), so a re-run corrects its own advice. `severity` is
`do-now`, `watch` or `good`. `metric` is the evidence, and a note without evidence is an
opinion: put the number that made you say it.

## The to-do list

```bash
postj /api/todo '{"title":"Chase INV-2291","detail":"63 days, $8,400","priority":1}'
```

Deduped on the exact open title, so re-adding the same job every run is safe and correct.
`priority` 1 is high. Do not add a to-do for something the owner cannot act on.

## Full pages

A rich report becomes its own tab:

```bash
post /ingest-page /tmp/page.json    # {"slug":"jobs","title":"Jobs","html":"<full html>"}
```

Write it as plain light HTML with its own inline styles. It renders in a sandboxed frame
on a white ground, so do not rely on the dashboard's colours and do not use scripts.

## Never invent a number

If a source was unavailable, say which one and set the status to `warn`. A card that quietly
drops Xero and reports on half the picture is worse than a card that says Xero was down.
