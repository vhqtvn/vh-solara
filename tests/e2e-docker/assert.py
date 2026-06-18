"""Assert a vh snapshot contains a completed user+assistant exchange for SID.

Reads the snapshot JSON on stdin; prints "OK" or "WAIT" on the first line, then
diagnostic lines. Exit code is always 0 so the caller controls retries.
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

msgs = d.get("messages", {}).get(sid, [])
roles = [m.get("info", {}).get("role") for m in msgs]
texts = []
for m in msgs:
    for p in m.get("parts", []):
        if p.get("type") == "text":
            texts.append(p.get("text", ""))
blob = " ".join(texts)

ok = (
    "user" in roles
    and "assistant" in roles
    and "FAKE-LLM reply" in blob
    and "hello from e2e" in blob
)
print("OK" if ok else "WAIT")
print("roles=%s" % roles)
print("text=%s" % blob[:200].replace("\n", " "))
