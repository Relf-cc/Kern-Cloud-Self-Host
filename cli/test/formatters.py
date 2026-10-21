"""Runs every python formatter embedded in cli/kernctl against a fixture that
matches what the management API actually returns."""
import io, json, re, subprocess, sys

src = io.open(sys.argv[1], encoding='utf-8').read()
helpers = re.search(r"PY_HELPERS=\$\(cat <<'PYEOF'\n(.*?)\nPYEOF\n\)", src, re.S).group(1)
blocks = re.findall(r"py '\n(.*?)\n'\)", src, re.S)

FIX = {}
FIX['overview'] = {
    "instance": {"name": "Acme Labs", "publicUrl": "https://kern.acme.test", "basePath": "/kern/v1",
                 "apiUrl": "https://kern.acme.test/kern/v1", "version": "1.0.0", "registration": "invite",
                 "startedAt": "2026-10-21T04:00:00.000Z", "uptimeSeconds": 93784,
                 "nodeVersion": "v22.9.0", "platform": "linux-x64"},
    "accounts": {"total": 12, "verified": 11, "held": 1, "newThisWeek": 2, "limit": 0},
    "spaces": {"personal": 12, "workspaces": 3, "deleted": 1, "records": 48213, "tombstones": 1902},
    "collaboration": {"members": 21, "openInvites": 2, "sharedWorkspaces": 2},
    "streams": {"total": 5, "enabled": 4, "deliveriesToday": 37, "failuresToday": 1},
    "shares": {"links": 8, "calendarFeeds": 3, "enabled": True},
    "storage": {"databaseBytes": 183500800, "assetBytes": 24117248, "assetCount": 42, "shareImageBytes": 1048576},
    "realtime": {"connections": 4, "rooms": 2},
    "mail": {"configured": True, "from": "Kern <no-reply@acme.test>"},
}
FIX['overview_bare'] = json.loads(json.dumps(FIX['overview']))
FIX['overview_bare']['shares']['enabled'] = False
FIX['overview_bare']['mail']['configured'] = False
FIX['overview_bare']['accounts'] = {"total": 0, "verified": 0, "held": 0, "newThisWeek": 0, "limit": 25}
FIX['overview_bare']['instance']['uptimeSeconds'] = 45
FIX['overview_bare']['realtime'] = {}

FIX['health'] = {"status": "warn", "fixable": ["expired-sessions"], "checks": [
    {"id": "database", "group": "database", "title": "Database reachable", "status": "ok",
     "detail": "PostgreSQL 17.0, answering in 3 ms.",
     "facts": {"version": "PostgreSQL 17.0", "roundTripMs": 3, "size": "175.0 MB"}},
    {"id": "expired-sessions", "group": "database", "title": "Expired sessions cleared", "status": "warn",
     "detail": "812 expired session rows left behind.",
     "fix": "Delete session rows that have already expired.", "facts": {"expired": 812}},
    {"id": "streams-key", "group": "security", "title": "Stream encryption key set", "status": "skip",
     "detail": "No streams exist yet."},
    {"id": "mail", "group": "mail", "title": "Outgoing email", "status": "fail",
     "detail": "Can't open a connection.", "fix": "Try a full SMTP handshake."},
]}
FIX['health_clean'] = {"status": "ok", "fixable": [], "checks": [
    {"id": "database", "group": "database", "title": "Database reachable", "status": "ok", "detail": "fine", "facts": {}},
]}

FIX['fixes'] = {"results": [
    {"id": "expired-sessions", "done": "Removed 812 expired sessions."},
    {"id": "mail", "done": "", "failed": "Connection refused"},
]}

FIX['users'] = {"total": 12, "limit": 200, "offset": 0, "users": [
    {"id": "u1", "name": "Ana Li", "email": "ana@acme.test", "emailVerified": True, "hasImage": False,
     "createdAt": "2026-09-01T10:00:00.000Z", "held": False, "holdReason": None,
     "spaces": 3, "activeSessions": 2, "records": 400},
    {"id": "u2", "name": "", "email": "bo@acme.test", "emailVerified": False, "hasImage": False,
     "createdAt": "2026-10-19T10:00:00.000Z", "held": True, "holdReason": "spam",
     "spaces": 1, "activeSessions": 0, "records": 0},
]}
FIX['users_empty'] = {"total": 0, "limit": 200, "offset": 0, "users": []}

FIX['user'] = {
    "user": FIX['users']['users'][1],
    "spaces": [{"id": "s1", "kind": "personal", "name": "Personal", "role": "owner", "members": 1, "records": 120}],
    "sessions": [{"id": "x", "createdAt": "2026-10-20T09:12:00.000Z", "expiresAt": "2026-12-20T09:12:00.000Z",
                  "ip": "10.0.0.4", "client": "Kern/0.2.3"}],
}
FIX['user_bare'] = {"user": FIX['users']['users'][0], "spaces": [], "sessions": []}

FIX['allow'] = {"registration": "invite", "allowed": [
    {"email": "new@acme.test", "note": "contractor", "createdAt": "2026-10-20T00:00:00.000Z", "usedAt": None},
    {"email": "old@acme.test", "note": "", "createdAt": "2026-10-01T00:00:00.000Z", "usedAt": "2026-10-02T00:00:00.000Z"},
]}
FIX['allow_empty'] = {"registration": "invite", "allowed": []}

FIX['spaces'] = {"limit": 200, "offset": 0, "spaces": [
    {"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "kind": "workspace", "name": "Product",
     "owner": {"id": "u1", "email": "ana@acme.test"}, "members": 6, "records": 9120, "tombstones": 210,
     "assets": 12, "assetBytes": 8388608, "streams": 2, "head": 9330,
     "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-10-21T00:00:00.000Z", "deletedAt": None},
    {"id": "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee", "kind": "personal", "name": "Personal",
     "owner": {"id": "u2", "email": "bo@acme.test"}, "members": 1, "records": 12, "tombstones": 0,
     "assets": 0, "assetBytes": 0, "streams": 0, "head": 12,
     "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-10-21T00:00:00.000Z",
     "deletedAt": "2026-10-20T00:00:00.000Z"},
]}
FIX['spaces_empty'] = {"limit": 200, "offset": 0, "spaces": []}

FIX['space'] = {
    "space": {"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "kind": "workspace", "name": "Product",
              "ownerId": "u1", "head": 9330, "createdAt": "2026-09-01T00:00:00.000Z", "deletedAt": None},
    "members": [{"id": "u1", "email": "ana@acme.test", "name": "Ana", "role": "owner",
                 "joinedAt": "2026-09-01T00:00:00.000Z"}],
    "tables": [{"table": "tasks", "records": 4000, "tombstones": 12},
               {"table": "notes", "records": 90, "tombstones": 0}],
}

FIX['invites'] = {"limit": 200, "offset": 0, "invites": [
    {"id": "11111111-2222-3333-4444-555555555555", "email": "new@acme.test", "role": "member",
     "workspace": {"id": "w", "name": "Product"}, "status": "pending",
     "createdAt": "2026-10-20T00:00:00.000Z", "expiresAt": "2026-11-03T00:00:00.000Z"},
]}
FIX['invites_empty'] = {"limit": 200, "offset": 0, "invites": []}

FIX['streams'] = {"limit": 200, "offset": 0, "streams": [
    {"id": "3f9c0a11…a1d0", "fullId": "3f9c0a11" + "0" * 52 + "a1d0", "name": "Website contact form",
     "enabled": True, "workspace": {"id": "w", "name": "Product"}, "deliveries": 412,
     "failuresThisWeek": 3, "lastDeliveryAt": "2026-10-21T03:50:00.000Z", "createdAt": "2026-09-10T00:00:00.000Z"},
    {"id": "aaaa1111…bbbb", "fullId": "a" * 64, "name": "Status page", "enabled": False,
     "workspace": {"id": "w", "name": "Product"}, "deliveries": 0, "failuresThisWeek": 0,
     "lastDeliveryAt": None, "createdAt": "2026-10-01T00:00:00.000Z"},
]}
FIX['streams_empty'] = {"limit": 200, "offset": 0, "streams": []}

FIX['settings'] = {
    "keys": ["instanceName"],
    "settings": {
        "instanceName": {"value": "Acme Labs", "source": "stored"},
        "supportEmail": {"value": "", "source": "env"},
        "registration": {"value": "invite", "source": "env"},
        "allowedEmailDomains": {"value": [], "source": "env"},
        "maxUsers": {"value": 0, "source": "env"},
        "sharesEnabled": {"value": True, "source": "env"},
        "motd": {"value": "", "source": "env"},
    },
    "environment": {
        "publicUrl": "https://kern.acme.test", "linkUrl": "https://kern.acme.test",
        "streamsUrl": "https://kern.acme.test", "apiUrl": "https://kern.acme.test/kern/v1",
        "appScheme": "kern", "port": 8787, "host": "::",
        "mail": {"configured": False, "host": "", "port": 587, "from": "Kern <no-reply@localhost>"},
        "inboundEmail": {"enabled": False, "domain": ""},
        "admin": {"localOnly": True, "allowFrom": [], "tokenFile": "/var/lib/kern/admin-token"},
        "limits": {}, "inviteDays": 14, "streamsKeySet": False,
    },
}
FIX['settings_open'] = json.loads(json.dumps(FIX['settings']))
FIX['settings_open']['settings']['allowedEmailDomains'] = {"value": ["acme.test"], "source": "stored"}
FIX['settings_open']['environment']['mail'] = {"configured": True, "host": "smtp.acme.test", "port": 587,
                                               "from": "Kern <no-reply@acme.test>"}
FIX['settings_open']['environment']['inboundEmail'] = {"enabled": True, "domain": "in.acme.test"}
FIX['settings_open']['environment']['admin'] = {"localOnly": False, "allowFrom": ["10.0.0.0/8"],
                                                "tokenFile": None}
FIX['settings_open']['environment']['streamsKeySet'] = True

FIX['tokens'] = {"tokens": [
    {"id": "0123456789abcdef", "name": "Bootstrap (first start)", "scope": "full",
     "createdAt": "2026-10-20T00:00:00.000Z", "lastUsedAt": "2026-10-21T04:00:00.000Z",
     "lastUsedIp": "127.0.0.1", "expiresAt": None, "revokedAt": None, "current": True},
    {"id": "fedcba9876543210", "name": "Old laptop", "scope": "read",
     "createdAt": "2026-10-01T00:00:00.000Z", "lastUsedAt": None, "lastUsedIp": None,
     "expiresAt": None, "revokedAt": "2026-10-10T00:00:00.000Z", "current": False},
]}

FIX['logs'] = {"latest": 42, "held": 42, "lines": [
    {"n": 41, "at": "2026-10-21T04:00:01.000Z", "level": "info",
     "text": "[kern] Acme Labs listening on http://[::]:8787/kern/v1"},
    {"n": 42, "at": "2026-10-21T04:00:02.000Z", "level": "warn", "text": "[mail] SMTP not configured"},
    {"n": 43, "at": "2026-10-21T04:00:03.000Z", "level": "error", "text": "[http] unhandled error"},
]}

FIX['audit'] = {"limit": 50, "offset": 0, "entries": [
    {"id": 7, "action": "user.hold", "target": "u2", "detail": {"email": "bo@acme.test", "reason": "spam"},
     "by": "Bootstrap (first start)", "ip": "127.0.0.1", "at": "2026-10-21T03:00:00.000Z"},
    {"id": 6, "action": "settings.update", "target": None, "detail": {}, "by": None, "ip": None,
     "at": "2026-10-21T02:00:00.000Z"},
]}

FIX['query'] = {"fields": ["kind", "n"], "rows": [{"kind": "workspace", "n": 3}, {"kind": "personal", "n": 12}],
                "rowCount": 2, "truncated": False}
FIX['query_empty'] = {"fields": [], "rows": [], "rowCount": 0, "truncated": False}

# The fixture each formatter expects, in the order they appear in the script.
ORDER = ['overview', 'fixes', 'health', 'users', 'user', 'allow', 'spaces', 'space',
         'invites', 'streams', 'settings', 'tokens', 'logs', 'audit', 'query']

if len(ORDER) != len(blocks):
    print(f"MISMATCH: {len(ORDER)} fixtures listed, {len(blocks)} formatters found")
    sys.exit(1)

show = "--show" in sys.argv
failures = 0
for name, block in zip(ORDER, blocks):
    program = helpers + "\n" + block
    variants = [name] + [k for k in (f"{name}_empty", f"{name}_bare", f"{name}_clean", f"{name}_open") if k in FIX]
    for key in variants:
        r = subprocess.run([sys.executable, '-I', '-c', program],
                           input=json.dumps(FIX[key]).encode(), capture_output=True)
        if r.returncode != 0:
            failures += 1
            tail = r.stderr.decode(errors='replace').strip().splitlines()
            print(f"  FAIL {key}: {tail[-1] if tail else '?'}")
        else:
            lines = r.stdout.decode('utf-8', errors='replace').splitlines()
            print(f"  ok   {key:<18} {len(lines)} lines")
            if show:
                for line in lines:
                    print("        | " + line)

print()
print("ALL FORMATTERS RUN CLEAN" if not failures else f"{failures} FAILING")
sys.exit(1 if failures else 0)
