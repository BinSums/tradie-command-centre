---
description: Set up the Command Centre from scratch. Checks what is missing, tells you how to fix it in plain words, then builds and deploys everything and schedules the routines.
---

# Set up the Command Centre

**Assume the person reading your messages has never used a terminal, has nobody helping them,
and is running a trades business.** They typed one command and everything else is on you.

That changes how you work here:

- **Never show a raw error.** Translate it. "Node.js is not installed yet" beats a stack trace.
- **Never say "stop" without a next action.** Say exactly what to click, then wait and re-check.
- **One thing at a time.** Ask one question, get one answer, move on. Do not send a numbered
  list of six things and hope.
- **Say what you are about to do before you do it**, in one plain sentence, and say what
  happened after. Silence for two minutes reads as broken.
- **Never paste a password or a token into the chat**, including to confirm it.
- If something genuinely cannot be fixed from here, say so plainly, say what you did manage to
  do, and tell them it is safe to close and come back.

Track your progress out loud, like "step 3 of 9". People abandon installs when they cannot tell
how far in they are.

---

## Step 1 of 10: is anything missing?

Check all of these before asking them for anything. Do not report problems one at a time as you
trip over them: find everything first, then give them one short list of what to fix.

```bash
node --version
npx wrangler whoami
```

**If `node` is missing or below v20.** Say: "You need one free program installed first, called
Node.js. It takes about two minutes." Send them to <https://nodejs.org/en/download>, tell them
to pick the big green LTS button for their computer, run the file it downloads, and click
through, accepting the defaults. Then tell them to **fully quit Claude and reopen it** (this is
the part everyone misses: a new program is not visible to an app that was already running).
Then have them run `/tradie-cc:setup` again.

**If `wrangler whoami` says nobody is signed in.** They need a free Cloudflare account. This is
where the dashboard will live and it is theirs, not yours. Say that. Send them to
<https://dash.cloudflare.com/sign-up>, have them sign up with their work email and confirm the
email, then run `npx wrangler login` for them, which opens their browser to an "Allow" button.
Wait for it. It can take them a minute to find the browser window.

**Xero.** Ask them to open Settings, then Connectors, find Xero, click Connect, sign in to Xero
and approve. Then verify it yourself by asking for their organisation name through the Xero
tools and reading the real name back to them: "I can see Xero now, it says Henderson Landscaping
Pty Ltd, is that right?" That is the check. Do not take their word for it.

**If Xero will not connect**, it is nearly always that the person at the keyboard is not the one
with the Xero login. Ask directly: "Are you the person who signs in to Xero, or is that your
bookkeeper?" If it is the bookkeeper, stop cleanly. Tell them everything else can be done now
but the dashboard would have no figures in it, so it is worth waiting. Offer to pick up exactly
here when the bookkeeper is available.

## Step 2 of 10: four questions

Ask them in **one** message, and say up front it is the only time they need to decide anything.

1. Business name, as it should appear at the top of the dashboard.
2. Their timezone. Offer `Australia/Sydney` as the default and let them just say yes.
3. Their currency. Default `AUD`.
4. A password for the dashboard. **Tell them to pick one and have it ready to type in a moment.
   Do not ask them to type it into the chat.** Say plainly: "I will not see it, and neither will
   anyone else."

## Step 3 of 10: build the database

Say first: "I am making a database inside your own Cloudflare account. Nothing leaves it."

**Copy the worker out of the plugin folder first.** The installed plugin lives in a folder
named after its version, so anything written there is orphaned the moment the plugin updates.
Their deployment config has to live somewhere that survives that.

```bash
mkdir -p ~/.command-centre/worker
cp "${CLAUDE_PLUGIN_ROOT}/worker/worker.js" "${CLAUDE_PLUGIN_ROOT}/worker/schema.sql" "${CLAUDE_PLUGIN_ROOT}/worker/wrangler.toml.template" ~/.command-centre/worker/
cd ~/.command-centre/worker
npx wrangler d1 create <business-slug>-cc-db
```

Take the `database_id` from the output. Write `wrangler.toml` next to it from
`wrangler.toml.template` using a python heredoc, filling `__WORKER_NAME__`,
`__BUSINESS_NAME__`, `__TIMEZONE__`, `__CURRENCY__`, `__DB_NAME__` and `__DB_ID__`. Then:

```bash
npx wrangler d1 execute <business-slug>-cc-db --remote --file=schema.sql   # from ~/.command-centre/worker
```

**`--remote` is not optional.** Without it the tables are built on their laptop while the live
dashboard talks to an empty database, and the symptom is a dashboard that loads perfectly with
nothing in it and no error anywhere. If you ever see that later, this is why.

## Step 4 of 10: three passwords

Generate the two random ones yourself and never display them:

```bash
openssl rand -base64 32
```

Explain in one line: "One is the password you just chose. The other two are long random keys I
generate, one to keep your login secure and one so the daily reports can post in."

`wrangler secret put` prompts for the value, so nothing is saved in their history:

```bash
npx wrangler secret put DASH_PASSWORD    # they type theirs, you look away
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put INGEST_SECRET
```

## Step 5 of 10: put it online

```bash
npx wrangler deploy
```

Give them the URL and ask them to open it and sign in **now**, while you are here. Tell them
before they click: "It will look empty. That is right, nothing has run yet."

If the password does not work, it was mistyped into the prompt. Just set `DASH_PASSWORD` again
rather than investigating.

Every `wrangler` command from here on runs in `~/.command-centre/worker`, never in the plugin
folder.

## Step 6 of 10: connect the reports to it

```bash
mkdir -p ~/.command-centre/bin
cp "${CLAUDE_PLUGIN_ROOT}/scripts/cc.sh" ~/.command-centre/bin/cc.sh
chmod +x ~/.command-centre/bin/cc.sh
```

Write `~/.command-centre/env` with mode 600 via a python heredoc, holding `CC_URL` and
`CC_TOKEN` (the `INGEST_SECRET` from step 4).

Then prove the whole loop works before going further:

```bash
bash ~/.command-centre/bin/cc.sh postj /ingest '{"skill_id":"setup","title":"Setup complete","status":"ok","summary_html":"<p>Your Command Centre is live.</p>","detail_html":"<p>Posted during setup to prove the connection works.</p>"}'
```

Ask them to refresh and tell you if they can see a card called "Setup complete". **Their answer
is the test, not the command exiting cleanly.** If they cannot see it, the token in `env` does
not match the deployed one: set `INGEST_SECRET` again and rewrite `env` with the same value.

## Step 7 of 10: let the reports run on their own

Say: "This lets the daily reports run at 7am without stopping to ask permission, since nobody
is awake to answer."

Xero is the part that cannot be prepared in advance, because its connector name is different on
every computer. Find the real Xero tool names now, take everything up to and including the
second pair of underscores, and add `*`. It looks like `mcp__something__*`.

Show them what will change, then do it:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py" --dry-run --mcp "mcp__<their-xero-prefix>__*"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install-permissions.py" --mcp "mcp__<their-xero-prefix>__*"
```

Tell them it backed up their settings first and removed nothing.

**If you get the Xero prefix wrong, every Xero call in every report is refused silently and the
dashboard reports confidently on half their business.** Step 9 is what catches that, so do not
skip it.

## Step 8 of 10: ten minutes about the business

Copy `templates/CLAUDE.md` into the folder the routines will run from, filling in the business
name, dashboard URL and their name. Use a python heredoc.

Then **go through the "About this business" section with them, one question at a time.** Busy
season, how long a normal job takes, payment terms, who is always slow to pay, anything a report
should never chase. Ask, wait, write down what they say in their words.

Tell them why: "This is what stops it giving you advice that sounds like it came off the
internet." It is the step people want to skip and the one that decides whether they keep using
it.

## Step 9 of 10: ask what they actually want watched

**Do not just install the four routines and move on.** They were written for a landscaping
business and they are a starting point, not an opinion about what matters to this one. A tiler
worries about different things from a plumber with a van full of stock.

Ask, plainly: **"Forget what I have shown you. What do you wish you knew every Monday that you
currently have to go digging for?"** Then shut up and let them answer. What comes out is usually
not on the list below.

Then work through what they actually track. Some of it you can do today, some needs another
connection, and some is a spreadsheet they will have to keep uploading:

| If they mention | What you can do about it |
| --- | --- |
| Materials and stock | Not in Xero usefully. Ask what they use. simPRO and AroFlo hold stock and have APIs; ServiceM8 has materials on jobs. A stock spreadsheet uploads like any other CSV. |
| Hours worked, labour cost | Tradify timesheets export as CSV. If they use a payroll product, ask which: several are reachable. |
| Quotes and win rate | Already covered, and worth showing them the conversion angle since most have never measured it. |
| Purchase orders, supplier bills | Xero has the bills. Tradify exports the POs. |
| Vehicles, plant, servicing | Usually a spreadsheet or nothing. Uploads fine, and a routine can watch service dates. |
| Certificates, licences, insurances | Usually expiry dates in someone's head. A tab with a warning routine is a ten minute build and they will love it. |
| Leads, where work comes from | Ask where enquiries land. If it is email, that is reachable. |
| Safety, SWMS, incidents | Handle carefully. Say what it can and cannot do rather than promising compliance. |

**Only schedule what they said they wanted.** A dashboard with three routines they asked for
beats one with six they did not.

Set up as scheduled tasks. Each prompt must be self-contained, because a scheduled run starts
fresh with no memory: name the skill, the working directory, and that it must load
`standing-rules` first.

| Routine | Cron | Where |
| --- | --- | --- |
| Morning brief | `52 6 * * 1-5` | Cloud or local |
| Routine audit | `41 4 * * *` | Cloud or local |
| Cash and debtors | `7 8 * * 1` | Cloud or local |
| Jobs and quotes | `33 8 * * 1` | Cloud or local |
| **Fetch from Tradify** | `12 7 * * 1` | **Local only, needs the browser** |

**Start with the morning brief and the audit.** Say the rest can be added any time by asking.
Two habits that stick beat five that get ignored.

**Cloud or local.** A cloud routine keeps running with the computer off, which is the better
answer for everything except the Tradify fetch. Tell them plainly: **these run while Claude is
open on this computer** if local, and if the machine is asleep the run happens when they next
open it.

## Step 9b of 10: offer the automatic Tradify fetch

Optional, and only worth doing if they will keep Chrome signed in to Tradify.

It replaces the weekly upload with a routine that opens Tradify in the browser, runs both
exports and uploads them. Explain why it needs a browser extension at all: **Tradify has no way
for another program to ask it for data, so the only route in is the screen, the same way a
person would do it.**

If they want it:

1. Install the Claude in Chrome extension from the Chrome Web Store. Works on Chrome and Edge,
   on both Mac and Windows.
2. Sign in to Tradify in that browser and tick remember me.
3. Schedule `fetch-from-tradify` as a **local** task.
4. **Run it once with Run now, and approve the browser permission prompts with "always
   allow".** Without this an unattended run stalls waiting for an approval nobody sees.

Tell them the honest trade: it saves a minute a week, and it stops working whenever their
Tradify session expires, at which point it tells them and they upload by hand until somebody
signs in again. The upload box never stops working regardless.

## Step 10 of 10: prove it works, then hand over

Do not finish on a promise.

1. **Run the morning brief now.** Look at the card with them.
2. **Read two real figures off it and ask them to confirm.** "It says you have $48,210 in the
   bank and $42,650 owed to you. Does that sound right?" If the numbers are missing or wrong,
   the Xero prefix in step 7 is wrong. Fix it and run it again.
3. **Check nothing was refused:**

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/scan-denials.py" 1
```

Fix anything it found now.

Then show them the Tradify export, which is the one job that stays theirs. **It is uploaded on
the dashboard, not saved into a folder**, so it works from any computer and the reports can read
it whether they run here or in the cloud.

- **Jobs**: the Jobs page, tick what they want or tick nothing for all of them, then
  **Options** in the top right, then **Export Jobs to File**.
- **Quotes**: the Quotes page, tick, then the **Export icon**. There is no Options menu on this
  one, which is what catches people out.
- Then open the dashboard, and on the Home tab drag the file onto **Add an export**. It works
  out which export it is on its own and confirms how many rows it saved.

**Walk them through one upload now, with a real file.** Reading about it is not the same as
having done it once.

Tell them straight: **if that stops, the jobs and quotes numbers go stale rather than going
blank.** The dashboard shows the age of each upload right there on the Home tab, and it turns
amber then red as it ages. Suggest they put a weekly reminder in their phone now, while you are
still here.

Finish with: the dashboard address, that it adds to a phone home screen from the browser share
menu, that anything they want it to watch they can just say in plain English, and that if
anything ever looks wrong they type `/tradie-cc:check`.
