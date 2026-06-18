"""Extract a pending permission for SID from a vh snapshot (stdin).

Prints "OK\n<permissionID>" once the aggregator has surfaced a pending bash
permission for the session, else "WAIT". This proves the `permission.asked`
event from real opencode propagated through the aggregator into the snapshot.
Exit code is always 0 so the caller controls retries.
"""
import json
import sys

sid = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception as e:  # noqa: BLE001
    print("WAIT")
    print("parse-error=%s" % e)
    sys.exit(0)

perms = d.get("permissions", {}).get(sid, [])
pid = ""
for p in perms:
    if p.get("id"):
        pid = p["id"]
        break

print("OK" if pid else "WAIT")
print(pid)
print("count=%d" % len(perms))
