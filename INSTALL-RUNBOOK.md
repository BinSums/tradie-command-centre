# Installer's runbook

For me, in the room. The client reads the PDF; this is the other side of it.

---

## Status: what is tested and what is not

Be honest with yourself about this before you book anything.

| Part | State |
| --- | --- |
| The dashboard itself | **Tested.** Runs, ingests, renders, login works, reports open. |
| The demo | **Tested.** `demo.sh` runs on a laptop with no accounts at all. |
| Plugin install from a local folder | **Tested.** Marketplace add, install, inventory verified. |
| Plugin install from GitHub | **Not tested.** No remote exists yet. See step 0. |
| `/tradie-cc:setup` against real Cloudflare | **NEVER RUN.** See step 0. |
| Xero connector discovery | **Not tested** against a second person's account. |

**Done, 28 Aug 2026.** Rehearsed end to end on my own Cloudflare: created, deployed, tested
live, deleted. It found two real bugs, so it was worth doing. Rehearse again after any change
to the worker or the setup steps.

---

## Step 0: before any client sees this

Once, and it is not optional.

**Rehearse the whole install.** Create a throwaway business name, run `/tradie-cc:setup`
against my own Cloudflare, deploy it, post a card, then delete the Worker and the D1. Time it.
Whatever breaks will break at a client too, and this is the cheap place to find out.

```bash
npx wrangler d1 list                 # see what is there before
npx wrangler delete <worker-name>    # clean up after
npx wrangler d1 delete <db-name>
```

**Decide how they install it.** Two routes:

- **Local folder** (works today, tested): copy the repo to their machine, then
  `/plugin marketplace add /path/to/tradie-command-centre`. Fine for a sit-down install and
  it means no GitHub account, no auth, nothing public.
- **Public GitHub** (not set up yet): create the repo, push, then they run
  `/plugin marketplace add BinSums/tradie-command-centre`. Needed if they ever install it
  themselves or if I want updates to reach them. There is nothing secret in the repo.

Until the repo is pushed, **the install line in the client PDF does not work.** Either push it
or tell them to ignore that line and do it from the folder.

---

## Before the meeting: four things to confirm with them

Ask these by email. Any one of them being wrong wastes the session.

1. **Who has the Xero login?** They need to sign in and approve during the install. If it is
   their bookkeeper and the bookkeeper is not there, stop and rebook.
2. **Whose laptop will this live on?** The routines run on one machine, and it needs to be
   on and awake at the scheduled times. A desktop in the office beats a laptop that goes home.
3. **Do they have admin rights on it?** Node.js needs installing.
4. **Who does the Tradify export?** By name. That person should be in the room for step 9.

---

## Meeting one: the demo. Forty minutes, install nothing.

**Start the demo before you walk in** so it is already on screen. It takes a minute to boot and
you do not want to spend that minute in silence.

```bash
bash ~/Documents/Claude/tradie-command-centre/plugins/tradie-cc/scripts/demo.sh
```

Open `http://127.0.0.1:8799`, password `demo`.

**Show it in this order.** It is built to be read top down and the order is the argument.

1. **The flags.** "Three jobs finished but never invoiced, $31,900." Let that sit. Ask them
   whether that happens to them. It does.
2. **The tiles.** Point out that debtor days falling shows green: it knows which direction is
   good for each number.
3. **The Jobs tab.** The detail behind the flags.
4. **Reports.** Every run kept forever. Open one so they see the full report behind a card.

**Then hand them the PDF and stop selling.** Point them at section 07, the Tradify limitation,
and say it out loud: Tradify has no way to hand data over automatically, so somebody exports a
CSV once a week or the jobs half goes stale. If that is a dealbreaker it is better to find out
now, and saying it first is what makes the rest of it credible.

**Three questions to close on:**

- Whose numbers would be on it, and who else should see it?
- What is the thing they wish they knew every morning and currently do not?
- Who does the Tradify export, and will they actually do it weekly?

Answer three tells me whether to build it at all.

---

## Meeting two: the install. Book ninety minutes, not sixty.

Sit next to them. Do not do this over a screen share the first time.

### Preflight, 10 minutes

```bash
node --version                # needs v20+
npx wrangler whoami           # who is signed in to Cloudflare
```

Get Xero connected **before** anything else: Settings, then Connectors, then Xero, then
Connect, sign in, approve. Then verify by asking Claude for their organisation name through the
Xero tools. **If the Xero tools do not answer, stop.** Everything downstream reports on nothing.

### Install the plugin, 5 minutes

```bash
/plugin marketplace add <folder path, or BinSums/tradie-command-centre once pushed>
/plugin install tradie-cc@sims-business-tools
```

### Run the setup, 30 minutes

```bash
/tradie-cc:setup
```

It asks four things. **Have them type the dashboard password themselves and do not look.**
That single gesture does more for trust than anything I can say.

### Watch for these three, they are where it will go wrong

**The database must be built with `--remote`.** Without it the tables land on their laptop and
the deployed dashboard talks to an empty database. Symptom: dashboard loads, everything empty,
no error anywhere.

**The Xero prefix.** Their connector's server name is generated per user, so the allowlist entry
cannot be prepared in advance. Setup discovers it and passes `--mcp`. Get it wrong and every
Xero call in every routine is denied **silently**, and the cards report confidently on half the
business. This is the single most likely thing to be quietly wrong when I leave.

**The permission merge.** Show them the `--dry-run` output before running it for real. It is the
only step that changes a file they already had. It backs up first and adds without removing.
Thirty seconds here buys the whole install.

### Fill in the business context, 10 minutes

The bottom of the `CLAUDE.md`: busy season, normal job turnaround, payment terms, who is always
slow, anything a routine must never chase. **Do this with them, not for them.** It is the boring
part and it is the difference between advice that fits and advice off the internet.

### Schedule, 5 minutes

Morning brief and the nightly audit to start. Add cash-and-debtors and jobs-and-quotes in a
fortnight. **Schedule the audit even if they want nothing else**: it is the only thing that
notices a run losing calls.

Tell them tasks run while the app is open, and one due while it was closed runs at next launch.

### Prove it, 15 minutes. Do not skip this.

```bash
# 1. run the morning brief by hand, look at the card together
# 2. confirm the Xero figures on it are really theirs
python3 <plugin>/scripts/scan-denials.py 1
```

If that run lost calls, fix it now while sitting there. This is the best single predictor of
whether the thing still works in a month.

### The export, 10 minutes

With the person who will actually do it. Walk both paths on their screen once:

- **Jobs**: Jobs page, Options top right, Export Jobs to File.
- **Quotes**: Quotes page, tick, then the Export icon. No Options menu on this one, which is
  what catches people out.

Then drag it onto **Add an export** on the dashboard Home tab. Do one real upload with them
rather than describing it. Put a weekly reminder in their calendar before leaving.

---

## The week after

- **Day 1:** check a card appeared. If not, the schedule did not fire.
- **Day 3:** run the denial scan remotely, or have them read the audit card to me.
- **Day 7:** ask whether they have read a single morning brief. If not, the problem is the
  content or the timing, not the software, and that is worth a call.

---

## If I have to walk away mid-install

Leave it deployed but unscheduled rather than half-scheduled. A dashboard with no routines is
inert and harmless. Routines firing into a broken config produce confident wrong numbers, which
is worse than nothing and much harder to recover trust from.
