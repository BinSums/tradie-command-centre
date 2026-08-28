#!/usr/bin/env python3
"""Find what the unattended runs silently lost.

    python3 scan-denials.py [days]        default 3

In dontAsk mode a tool call that is not on the allowlist is DENIED and the run keeps
going without it. Nothing raises, nothing emails, and the card still posts, just with
a hole in it. This reads the run transcripts and reports:

  - every denied call, grouped BY ROUTINE, with the tool and the exact input
  - repeated tool errors (a dead connector, an expired token, a 403)
  - runs that produced no card at all

Grouping by routine is the whole point. A denial count with no owner does not get
fixed, because nobody knows which routine to repair.

Read-only. Safe to run any time.
"""
import json, glob, os, re, sys, time
from collections import Counter, defaultdict

DAYS = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
now = time.time()

# Every project the user has, not one hardcoded folder: a routine runs in whatever
# directory it was scheduled from, and that decides which project dir it writes to.
roots = glob.glob(os.path.expanduser('~/.claude/projects/*'))
files = []
for r in roots:
    for f in glob.glob(os.path.join(r, '*.jsonl')):
        try:
            if now - os.path.getmtime(f) < DAYS * 86400:
                files.append(f)
        except OSError:
            pass

if not files:
    print('No run transcripts in the last %g days.' % DAYS)
    print('If a routine was meant to fire in that window, that is itself the finding:')
    print('the schedule is not running, or the machine was asleep when it was due.')
    sys.exit(0)

by_task = Counter()
by_task_tool = defaultdict(Counter)
samples = defaultdict(list)
errs_by_task = defaultdict(Counter)
seen_tasks = Counter()
total_denied = 0

for f in sorted(files, key=os.path.getmtime):
    uses, denied, errs, task = {}, [], Counter(), None
    try:
        for line in open(f, errors='replace'):
            if task is None and 'scheduled task' in line:
                m = re.search(r'scheduled-tasks/([a-z0-9-]+)/SKILL\.md', line)
                if m:
                    task = m.group(1)
            if '"tool_use"' not in line and '"tool_result"' not in line:
                continue
            try:
                j = json.loads(line)
            except Exception:
                continue
            for c in (j.get('message', {}) or {}).get('content') or []:
                if not isinstance(c, dict):
                    continue
                if c.get('type') == 'tool_use':
                    uses[c.get('id')] = (c.get('name'), c.get('input'))
                elif c.get('type') == 'tool_result':
                    body = str(c.get('content', ''))
                    # Match the harness's exact denial sentence only. A looser test on
                    # "permission to use" also matches a run that merely PRINTED that
                    # phrase, e.g. this scanner's own output, and inflates the count.
                    if 'has been denied because' in body:
                        denied.append(c.get('tool_use_id'))
                    elif c.get('is_error'):
                        errs[body.strip()[:110]] += 1
    except Exception as e:
        print('!! could not read %s: %s' % (os.path.basename(f), e))
        continue

    label = task or 'INTERACTIVE (someone at the keyboard)'
    seen_tasks[label] += 1
    for tid in denied:
        name, inp = uses.get(tid, ('?', None))
        total_denied += 1
        by_task[label] += 1
        by_task_tool[label][name] += 1
        if len(samples[label]) < 4:
            s = json.dumps(inp)[:180] if inp is not None else ''
            samples[label].append('%s  %s' % (name, s))
    for k, v in errs.items():
        if v >= 2:
            errs_by_task[label][k] += v

print('=' * 72)
print('DENIALS AND ERRORS, last %g days, %d transcripts' % (DAYS, len(files)))
print('=' * 72)

if not total_denied:
    print('\nNo denied calls. The allowlist covers what the routines actually do.')
else:
    print('\n%d denied calls.\n' % total_denied)
    for label, n in by_task.most_common():
        kind = 'ROUTINE' if not label.startswith('INTERACTIVE') else 'INTERACTIVE'
        print('  [%s] %s  ...  %d denied' % (kind, label, n))
        for tool, c in by_task_tool[label].most_common():
            print('        %-28s x%d' % (tool, c))
        for s in samples[label]:
            print('        e.g. %s' % s)
        print()
    print('  A denial in a ROUTINE is silent data loss and must be fixed.')
    print('  A denial in an INTERACTIVE session cost somebody one keystroke. Lower priority.')

if errs_by_task:
    print('\n' + '-' * 72)
    print('REPEATED TOOL ERRORS (2+ in one run, usually a dead connector or token)')
    print('-' * 72)
    for label, c in errs_by_task.items():
        print('\n  %s' % label)
        for msg, n in c.most_common(5):
            print('     x%-3d %s' % (n, msg.replace('\n', ' ')))

print('\n' + '-' * 72)
print('RUNS SEEN')
print('-' * 72)
for label, n in seen_tasks.most_common():
    print('  %-46s %d run(s)' % (label, n))
