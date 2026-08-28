---
name: cash-and-debtors
description: Weekly cash and debtors watch for a trades or landscaping business. Use when the owner says "who owes us", "cash position", "debtors", "chase invoices", "aged receivables", or on the scheduled Monday run. Reads Xero, works out what is genuinely worth chasing this week, and posts it to the Command Centre.
---

# Cash and debtors

The job is not to list overdue invoices. Xero already does that and nobody reads it. The
job is to say **which two or three to chase this week, and why those ones.**

Load `posting-to-the-command-centre` first, and work the queue before anything else.

## What to pull from Xero

Through the Xero connector:

- Cash position across bank accounts.
- Aged receivables, by contact, with the ageing buckets.
- Aged payables, so "we are owed a lot" is not reported while a bigger bill is due Friday.

If the Xero tools are not available, post a card with status `alert` saying Xero could not
be reached, and stop. Do not fall back to stale numbers without labelling them stale.

## Work out the three things that matter

**Debtor days.** Total receivables divided by average daily sales over the last 90 days.
This is the number that tells the owner whether the problem is getting worse. Report the
trend, not just the level: 47 days is meaningless on its own, 47 up from 34 is a story.

**What is genuinely at risk.** Sort by amount, not by age. A $12,000 invoice at 45 days is
a bigger problem than four $400 invoices at 90 days, even though the 90s look worse in a
list. Trades businesses die of one big unpaid job, not a tail of small ones.

**Whether chasing is the constraint.** Compare receivables to payables and to cash. If
there is $60k in the bank and $14k owed, the honest note is "nothing urgent", and saying so
is more valuable than manufacturing an action. Do not invent urgency to justify the run.

## What to post

A card, `skill_id` `cash-and-debtors`. Status honestly: `alert` if cash will not cover the
next fortnight of known payables, `warn` if debtor days are up materially, otherwise `ok`.

Metrics, every run: `cash_at_bank`, `debtors_total`, `debtors_over_60`, `debtor_days`.

Notes, area `cash`. At most two. Each one names the customer, the amount and the age, and
says what to do. "Ring Henderson about INV-2291, $8,400, 63 days" beats "follow up on aged
receivables". If nothing needs doing, post one `good` note saying so.

To-dos, only for invoices genuinely worth a phone call this week. One per invoice, priority
1 if it is over 60 days and over $5,000. Never add a to-do for an invoice already on the
list: the dedupe is on exact title, so keep the title format stable, e.g.
`Chase <customer> <invoice number>`.

## What not to do

Do not chase an invoice for a job that is still in dispute, and do not chase one that is on
an agreed payment plan. You will not know either from Xero alone, so when a large invoice
has been sitting a long time without a follow-up recorded, say "worth checking whether this
is disputed before ringing" rather than issuing an instruction.
