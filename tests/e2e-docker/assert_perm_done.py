"""Assert the bash-permission turn resumed and finished for SID (stdin = snap).

After the permission is granted, opencode runs the bash tool and the follow-up
turn must terminate with the fake-LLM "finished" text, and the pending
permission must be cleared. Prints "OK"/"WAIT" then diagnostics; exit 0 always.
"""
import json
import sys

sid = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:  # noqa: BLE001
    print("WAIT")
    print("parse-error")
    sys.exit(0)

msgs = d.get("messages", {}).get(sid, [])
texts = []
for m in msgs:
    for p in m.get("parts", []):
        if p.get("type") == "text":
            texts.append(p.get("text", ""))
blob = " ".join(texts)

pending = len(d.get("permissions", {}).get(sid, []))
ok = "FAKE-LLM finished the requested tool task." in blob and pending == 0
print("OK" if ok else "WAIT")
print("pending=%d" % pending)
print("text=%s" % blob[-200:].replace("\n", " "))
