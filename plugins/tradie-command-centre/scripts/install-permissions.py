#!/usr/bin/env python3
"""Merge the routines' permission allowlist into the user's own settings.json.

Run by /tradie-cc:setup. Safe to re-run: it adds what is missing, never removes,
never reorders, and never touches a key it does not own. Backs up first.

    python3 install-permissions.py [--dry-run] [--mcp mcp__xero__*] ...

The --mcp arguments matter more than they look. Xero reaches Claude through a
connector whose server name is generated per user, so it cannot be hardcoded here.
Setup discovers the actual tool names and passes them in. Get this wrong and every
Xero call in every routine is denied silently, and the cards quietly report on half
the business.
"""
import json, os, shutil, sys, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(os.path.dirname(HERE), 'settings', 'permissions.json')
TARGET = os.path.expanduser('~/.claude/settings.json')

def main():
    args = sys.argv[1:]
    dry = '--dry-run' in args
    extra = [args[i + 1] for i, a in enumerate(args) if a == '--mcp' and i + 1 < len(args)]

    home = os.path.expanduser('~')
    user = os.path.basename(home)

    tpl = json.load(open(TEMPLATE))
    wanted = [e.replace('__USER__', user) for e in tpl['allow']] + extra
    # Absolute and tilde forms of the same path are different strings to the matcher,
    # so a rule written one way does not cover a call made the other way.
    wanted += [e.replace(home, '~', 1) for e in wanted if e.startswith(('Write(' + home, 'Edit(' + home, 'Bash(' + home))]
    wanted = list(dict.fromkeys(wanted))

    if os.path.exists(TARGET):
        try:
            cur = json.load(open(TARGET))
        except json.JSONDecodeError as e:
            print('REFUSING TO WRITE: %s is not valid JSON (%s).' % (TARGET, e))
            print('Fix it by hand first. Overwriting it would lose whatever else is in there.')
            return 2
    else:
        cur = {}

    perms = cur.setdefault('permissions', {})
    have = perms.setdefault('allow', [])
    if not isinstance(have, list):
        print('REFUSING TO WRITE: permissions.allow is not a list.'); return 2

    added = [e for e in wanted if e not in have]
    mode_before = perms.get('defaultMode')

    print('settings file : %s' % TARGET)
    print('existing rules: %d' % len(have))
    print('adding        : %d' % len(added))
    for e in added:
        print('   + %s' % e)
    if mode_before != 'dontAsk':
        print('defaultMode   : %r -> "dontAsk"' % mode_before)
    else:
        print('defaultMode   : already "dontAsk", unchanged')

    if dry:
        print('\n--dry-run, nothing written.')
        return 0

    if os.path.exists(TARGET):
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        bak = '%s.bak-%s' % (TARGET, stamp)
        shutil.copy(TARGET, bak)
        print('\nbacked up to  : %s' % bak)

    have.extend(added)
    perms['defaultMode'] = 'dontAsk'
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    tmp = TARGET + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cur, f, indent=2)
        f.write('\n')
    json.load(open(tmp))          # never leave a half-written settings file in place
    os.replace(tmp, TARGET)
    print('written and re-parsed OK. %d rules now allowed.' % len(have))
    return 0

if __name__ == '__main__':
    sys.exit(main())
