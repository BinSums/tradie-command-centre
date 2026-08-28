---
name: standing-rules
description: The rules every scheduled routine follows when it runs unattended. Load this at the start of any routine, and before writing or changing one. Covers fixing rather than reporting, what to escalate, and the file-writing rules that stop a run silently losing work in dontAsk mode.
---

# Standing rules for unattended runs

These apply to every routine in this plugin. Read them first, every time.

## Fix it, do not report it

If a run finds a fault in the tooling, the data or the rules it works from, **repair it in
that run** and say what was repaired. Do not hand it back under "needs a look" and do not
leave it for the next run, which will only rediscover it.

This is narrower than it sounds and it does not change what a routine is for. A reporting
routine still reports. It means the plumbing underneath gets mended instead of worked around.

Prefer a structural fix to a one-off correction. A check that fails loudly beats a paragraph
nobody rereads. If a rule is enforced on one of two code paths, that is a bug, not a
difference of opinion.

## Escalate only what genuinely needs the owner

Say plainly on the card that it is blocked on them:

- anything needing their password, their hardware, or a permission only they can grant
- spending money, or sending anything to a customer or a supplier
- deleting or overwriting real data, and anything else hard to reverse
- a judgement that is genuinely their commercial call

Everything else: do it, then report what changed.

## The dontAsk trap, and the file rule that avoids it

Routines run with `defaultMode: "dontAsk"` so no approval prompt blocks a 6am run. The cost
is that **a tool call outside the allowlist is denied silently.** Nothing raises. The run
carries on and the card still posts, just with a hole in it where the data should be.

Measured on a live machine running this pattern, 28 August 2026: 42 denied calls across four
routines in two days, and **every denied `Edit` and `Write` targeted a path that an allow rule
already covered.** Path rules for those two tools are not reliably honoured in this mode.

Be accurate about what that costs, because it is not usually lost work. The denial message tells
the model to try another tool, and it does: in 13 of those 14 cases the run recovered by writing
a python script and executing it, and the change landed. The routine cost was a wasted turn each
time, not a wrong result. In 1 of 14 it did not recover and the file was never written, with
nothing to say so. So this is mostly an efficiency rule and occasionally a correctness one, and
it is cheap either way:

- **Never use `Edit` or `Write` on a file outside `/tmp`.** Write the change inside a
  `python3` script and run that instead. `Bash(python3:*)` matches reliably, so the change
  lands first time instead of after a denial and a retry.
- **Read files with the `Read` tool**, not `sed -n` or `head` on a path.
- **One simple command per Bash call.** A compound of a variable assignment, a command
  substitution and a pipe does not match an allowlist entry and is denied whole. Put the
  logic in a python script and make one call to it.
- **Never `source` a secrets file inline.** Use the `cc.sh` helper, which loads what it needs
  internally.
- **Redirect with `tee`**, not a bare `>`.

When a file does need changing, the shape that works:

```bash
python3 - <<'PY'
import shutil
p = '/absolute/path/to/file'
shutil.copy(p, p + '.bak')          # so the change is reversible
s = open(p).read()
assert 'the exact old text' in s    # fail loudly rather than writing nothing
open(p, 'w').write(s.replace('the exact old text', 'the new text'))
print(open(p).read()[:200])         # read back, so the run can verify it landed
PY
```

## Never invent a number

If a source was unavailable, name it on the card and set the status to `warn`. A card that
quietly drops Xero and reports on half the business is worse than one that says Xero was down.
A missing number is null, never zero.

## Work the queue first

Every run fetches the queue before doing anything else, acts on what is there, and marks it
done. Never leave an item unread. If it cannot be done, say so on the card.

```bash
bash ~/.command-centre/bin/cc.sh get /api/assistant-queue
```
