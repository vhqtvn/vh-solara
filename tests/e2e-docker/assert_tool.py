"""Assert a session contains a completed `write` tool part. stdin = snapshot."""
import json
import sys

sid = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:  # noqa: BLE001
    print("WAIT"); print("parse-error"); sys.exit(0)

msgs = d.get("messages", {}).get(sid, [])
tools = []
done = False
for m in msgs:
    for p in m.get("parts", []):
        if p.get("type") == "tool":
            tools.append(p.get("tool"))
            if p.get("tool") == "write" and (p.get("state", {}) or {}).get("status") == "completed":
                done = True
print("OK" if done else "WAIT")
print("tools=%s" % tools)
