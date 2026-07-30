#!/usr/bin/env python3
"""Assert a GET /session/:sid/message/:mid body (stdin) is the persisted
caller-minted USER message, proving the exact-match reconciliation primitive.

argv[1] = the minted message id the caller threaded into prompt_async's
`messageID` body key.

Reads the message JSON on stdin; prints "OK" or "WAIT" on the first line, then
diagnostic lines. Exit code is always 0 so the caller controls retries (mirrors
the assert*.py convention used by tests/e2e-docker/run.sh).

OK requires the EXACT-match authority (see
researches/sources/opencode-v1.17.18-messageid-exact-lookup.md §5):
  - info.id === minted       (caller-id-wins, no remint)
  - info.role === "user"     (the persisted user message, not the assistant reply)
Anything weaker does NOT qualify — the reconciler matches on exactly these two.
"""
import json
import sys

minted = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception as e:  # noqa: BLE001
    print("WAIT")
    print("parse-error=%s" % e)
    sys.exit(0)

info = d.get("info", {}) or {}
mid = info.get("id", "")
role = info.get("role", "")

ok = mid == minted and role == "user"
print("OK" if ok else "WAIT")
print("info.id=%s (want %s)" % (mid, minted))
print("info.role=%s" % role)
