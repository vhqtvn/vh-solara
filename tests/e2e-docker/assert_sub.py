"""Assert the session tree contains a child of PARENT. stdin = tree snapshot."""
import json
import sys

parent = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:  # noqa: BLE001
    print("WAIT"); print("parse-error"); sys.exit(0)

children = [s.get("id") for s in d.get("sessions", []) if s.get("parentID") == parent]
print("OK" if children else "WAIT")
print("children=%s" % children)
