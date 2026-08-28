---
name: fetch-from-tradify
description: Fetch the Tradify jobs and quotes exports through the browser and upload them to the dashboard, so nobody has to do it by hand. Use when the owner says "get the Tradify data", "fetch the exports", "update the jobs numbers", or on the scheduled weekly run. Needs Chrome and a signed-in Tradify session.
---

# Fetch from Tradify

Tradify has no API, so the only way in is the screen. This drives the browser the way a
person would: open Tradify, export Jobs and Quotes, and upload both to the dashboard.

Load `standing-rules` first.

## This one has to run on the machine, not in the cloud

Every other routine here can run as a cloud routine. **This one cannot.** A cloud run has no
browser and no logged-in Tradify session. Schedule it as a **local** scheduled task on the
computer that has Chrome, and leave the reporting routines in the cloud.

That split is deliberate. This is the fragile step, so it is isolated: if it fails, the cloud
reports still run and simply say the jobs data is a few days old, which the dashboard already
shows in amber. Nothing else breaks.

## Before it can work

- Chrome, Edge, or another Chromium browser, with the Claude in Chrome extension installed.
- **Signed in to Tradify in that browser, with "remember me" ticked.** This is the whole
  dependency, and it is why the routine can stop working without anything being broken.
- The task's permissions set to always-allow for browser actions on `tradifyhq.com`, so an
  unattended run does not stall waiting for approval.

## What to do

**1. Check the browser is actually there.** If the extension is not connected, stop. Post a
`warn` card saying the browser is not connected and the exports could not be fetched, and say
they can still upload by hand on the dashboard. Do not fail silently.

**2. Open Tradify and check you are signed in.**

Navigate to the Jobs page. Read the page.

**If a login screen appears, stop immediately.** Do not type anything into it, do not attempt
to sign in, and do not go looking for saved credentials. Post a `warn` card saying the Tradify
session has expired and somebody needs to sign in once in Chrome, after which this will start
working again on its own. **A routine that tries to log in on someone's behalf is a routine
nobody should trust**, and a stalled run is far better than that.

**3. Export Jobs.** On the Jobs page, click **Options** in the top right, then **Export Jobs
to File**. It downloads a CSV.

**4. Export Quotes.** Go to the Quotes page. There is no Options menu here: click the
**Export icon** directly. It downloads a second CSV.

**5. Find what was downloaded.** Do this in one python call, so it works the same on a Mac and
on Windows:

```bash
python3 - <<'PY'
import pathlib, time
d = pathlib.Path.home() / "Downloads"
recent = [p for p in d.glob("*.csv") if time.time() - p.stat().st_mtime < 600]
for p in sorted(recent, key=lambda p: p.stat().st_mtime, reverse=True)[:5]:
    print(p, p.stat().st_size)
PY
```

Only look at files touched in the last ten minutes. An old export sitting in Downloads from
last month is exactly the sort of thing that gets uploaded by accident and then reported as
current.

**6. Upload each one.** The dashboard works out which export it is from the header row, so
there is nothing to label:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("<the file>")
json.dump({"filename": p.name, "csv": p.read_text(errors="replace")}, open("/tmp/imp.json", "w"))
PY
bash ~/.command-centre/bin/cc.sh post /api/import-upload /tmp/imp.json
```

Check the response. It reports the source it recognised and the row count. **If it says it
could not tell what the export is, the download is not what you think it is**, most likely a
page that rendered instead of a file. Say that on the card rather than treating it as done.

**7. Tidy up.** Delete the two CSVs from Downloads once uploaded, so the next run cannot pick
up a stale one. Leave anything you did not download alone.

## What to post

A card, `skill_id` `fetch-from-tradify`. Keep it short: this is plumbing, not a report.

- `ok`: both uploaded, with the row counts.
- `warn`: browser not connected, session expired, or only one of the two worked. Say which,
  and say the reports will use the older data and show its age.
- `alert`: only if it has failed several runs in a row, because by then the jobs numbers are
  genuinely stale and somebody needs to look.

Do not post metrics or notes. The jobs and quotes report reads the uploads and does that.

## When to give up on this and go back to doing it by hand

Say so plainly if it fails three runs running. Automating a screen is always a little brittle,
and a weekly minute of somebody's time is better than a number nobody trusts. The upload box
on the dashboard never stops working, whatever happens here.
