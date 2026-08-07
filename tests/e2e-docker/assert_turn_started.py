#!/usr/bin/env python3
"""Assert a vh snapshot shows the session's turn has STARTED (activity == busy).

argv[1] = the session id whose turn-start we are confirming.

Reads the snapshot JSON on stdin; prints "OK" or "WAIT" on the first line, then
diagnostic lines. Exit code is always 0 so the caller controls retries (mirrors
the assert*.py convention used by tests/e2e-docker/run.sh).

OK requires the session's current activity to be "busy" — i.e. a turn is
running after the dispatch POST. Preferred source is gate[sid].activity (the
denormalized GateFacts summary a coordinator reads, pkg/state/store.go:255);
falls back to the top-level activity[sid] map (the snapshot-only facet,
pkg/state/store.go:178) when the gate entry is absent or shaped differently.
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

gate = d.get("gate") or {}
gf = gate.get(sid) if isinstance(gate, dict) else None
g_activity = gf.get("activity", "") if isinstance(gf, dict) else ""
activity_map = d.get("activity") or {}
a_activity = activity_map.get(sid, "") if isinstance(activity_map, dict) else ""

activity = g_activity or a_activity
ok = activity == "busy"
print("OK" if ok else "WAIT")
print("gate.activity=%s activity=%s (want busy)" % (g_activity, a_activity))
