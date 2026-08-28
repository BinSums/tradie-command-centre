---
description: Set up the Command Centre. Creates the database, deploys the dashboard to your own Cloudflare account, and schedules the routines.
---

# Set up the Command Centre

You are walking a business owner (or their office manager) through a one-off install.
They are not a developer. Explain each step in one plain sentence before you run it, and
never paste a secret into the chat.

Everything deploys into **their** Cloudflare account and **their** Xero. Nothing is sent
anywhere else. Say so out loud at the start, because it is the first thing anyone asks.

## Step 0: what they need before starting

Check these and stop if any is missing:

- **Node.js.** `node --version`. Needs v20 or newer. If missing, point them at nodejs.org.
- **A Cloudflare account.** Free tier is fine. `npx wrangler whoami` shows who is signed
  in; if nobody is, `npx wrangler login` opens a browser to sign in or sign up.
- **Xero, connected to Claude.** This is not something you can do for them. Tell them:
  open Settings, then Connectors, find Xero, click Connect, sign in to Xero and approve.
  Verify it worked by asking for their organisation name through the Xero tools. If the
  Xero tools are not available, stop here: the routines have nothing to read without it.

## Step 1: ask four things

Ask in one message, and take sensible defaults if they do not care:

1. Business name, as it should appear at the top of the dashboard.
2. Timezone (default `Australia/Sydney`).
3. Currency (default `AUD`).
4. A password for the dashboard. **Do not suggest one and do not echo it back.** Tell them
   to pick something and have it ready to type into a prompt.

## Step 2: create the database

```bash
cd "${CLAUDE_PLUGIN_ROOT}/worker"
npx wrangler d1 create <business-slug>-cc-db
```

That prints a `database_id`. Copy `wrangler.toml.template` to `wrangler.toml` and fill in
the five placeholders: `__WORKER_NAME__`, `__BUSINESS_NAME__`, `__TIMEZONE__`,
`__CURRENCY__`, `__DB_NAME__`, `__DB_ID__`. Then create the tables:

```bash
npx wrangler d1 execute <business-slug>-cc-db --remote --file=schema.sql
```

`--remote` matters. Without it you build the tables on their laptop and the deployed
dashboard talks to an empty database.

## Step 3: set the three secrets

Generate the two random ones yourself and never show them in the chat:

```bash
openssl rand -base64 32
```

Then set all three. `wrangler secret put` prompts for the value, so the secret is typed
into a prompt rather than sitting in shell history:

```bash
npx wrangler secret put DASH_PASSWORD    # they type their password
npx wrangler secret put COOKIE_SECRET    # paste a generated random string
npx wrangler secret put INGEST_SECRET    # paste a second, different random string
```

## Step 4: deploy

```bash
npx wrangler deploy
```

This prints the URL, something like `https://<name>.<their-subdomain>.workers.dev`. Open
it, sign in with the password from step 3, and confirm the dashboard loads. It will be
empty. That is correct: nothing has run yet.

## Step 5: write the local config

The routines need to know where to post. Write `~/.command-centre/env` with mode 600:

```
CC_URL=https://<the deployed url>
CC_TOKEN=<the INGEST_SECRET from step 3>
```

Then prove the whole loop works before you leave:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/cc.sh" postj /ingest '{"skill_id":"setup","title":"Setup complete","status":"ok","summary_html":"<p>The Command Centre is live and routines can post to it.</p>","detail_html":"<p>Posted by the setup command to prove the connection works end to end.</p>"}'
```

Refresh the Reports tab. If the card is there, the install is done. If it is not, the
token in `~/.command-centre/env` does not match the deployed `INGEST_SECRET`: set it again
rather than guessing.

## Step 6: label the numbers

The dashboard only shows a tile for a metric it has a label for. Seed the standard set:

```bash
npx wrangler d1 execute <business-slug>-cc-db --remote --command "INSERT OR REPLACE INTO metric_meta (key,label,unit,better,sort,tile) VALUES ('cash_at_bank','Cash at bank','money','up',1,1),('debtors_total','Owed to us','money','down',2,1),('debtors_over_60','Invoices 60d+','count','down',3,1),('debtor_days','Debtor days','days','down',4,1),('quotes_out','Quotes out','count','up',5,1),('quotes_value','Quoted value','money','up',6,1),('jobs_active','Jobs active','count','up',7,1),('revenue_mtd','Revenue MTD','money','up',8,1)"
```

## Step 7: schedule the routines

Ask which they want. Recommend starting with just the morning brief, because a dashboard
nobody reads is worse than no dashboard, and one good habit beats five ignored ones.

- **Morning brief**, weekdays 7:00am. `/tradie-cc:morning-brief`
- **Cash and debtors**, Mondays 8:00am. `/tradie-cc:cash-and-debtors`
- **Jobs and quotes**, Mondays 8:30am. `/tradie-cc:jobs-and-quotes`

Set these up as scheduled tasks on their machine. Confirm the timezone matches step 1.

## Step 8: the Tradify export habit

This is the part that fails if you skip it, so do not skip it.

Tradify has no API. The jobs and quotes routine reads a CSV they export by hand. The two
exports sit behind different controls, so show them both once rather than describing one:

- **Jobs**: the Jobs page, filter or tick what they want (ticking nothing exports everything
  in the current tab), then **Options** in the top right, then **Export Jobs to File**.
- **Quotes**: the Quotes page, tick what they want, then the **Export icon**. There is no
  Options menu on this one.
- **Better still, if they will do it**: the **Reports** page has a *Job Financial Report*,
  which carries job values and costs the plain Jobs export does not. Download arrow, then
  Download CSV File.

Save them into `~/.command-centre/imports/`. Tell them plainly: **if they stop dropping the export,
the jobs numbers stop updating and go stale rather than going blank.** The routine says how
old its data is on every card for exactly this reason.

## Finally

Tell them where the dashboard is, that it installs to a phone home screen from the browser
share menu, and that anything they want it to notice can be said in plain English to Claude,
which the queue picks up on the next run.
