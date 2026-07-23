#!/usr/bin/env python3
"""Assert the missed-delete reconcile emitted node.remove (behavior C -- THE CRUX).

Reads the RAW SSE text captured from a LONG-LIVED `GET /vh/stream?tree=2`
connection on stdin. That connection saw the cold snapshot (so the victim is
`known` to it), then run.sh raw-DELETED the victim row directly in the
container's opencode SQLite (bypassing the opencode app => NO session.deleted
event => a genuine missed delete only the reconcile ticker can catch), then
waited through multiple reconcile ticks (~5s each).

Asserts:
  C1. the cold snapshot shipped ses_tree_victim (so it is `known` to this
      connection -- node.remove is only emitted for known ids).
  C2. a node.remove op for ses_tree_victim arrived on this live stream.
  C3. NO node.upsert re-created ses_tree_victim after the remove (no
      resurrection across subsequent reconcile ticks).

C2 passing here is the Phase 2->3 gate: it can ONLY be produced by the
reconcile ticker against a real opencode SQLite (the in-process e2e's fake
opencode cannot synthesize a missed delete).

Prints "OK"/"WAIT" then diagnostics; exit 0 always.
"""
import json
import sys

VICTIM = "ses_tree_victim"


def parse_events(text):
    """Parse SSE text into a list of dicts {event, data(obj|None), id}."""
    events = []
    cur = None
    for line in text.splitlines():
        if line == "":
            if cur is not None:
                events.append(cur)
                cur = None
            continue
        if cur is None:
            cur = {"event": "", "data": None, "id": ""}
        if line.startswith("event:"):
            cur["event"] = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            payload = line.split(":", 1)[1].strip()
            try:
                cur["data"] = json.loads(payload)
            except Exception:
                cur["data"] = None
        elif line.startswith("id:"):
            cur["id"] = line.split(":", 1)[1].strip()
    if cur is not None:
        events.append(cur)
    return events


def main():
    text = sys.stdin.read()
    events = parse_events(text)

    # C1: victim was shipped in a snapshot (known to this connection).
    victim_in_snapshot = False
    for ev in events:
        if ev["event"] == "tree.snapshot" and ev["data"]:
            ids = {n.get("id") for n in (ev["data"].get("nodes") or [])}
            if VICTIM in ids:
                victim_in_snapshot = True
                break

    # C2: a node.remove for the victim.
    remove_seq = None
    for ev in events:
        if ev["event"] != "tree.op":
            continue
        data = ev["data"] or {}
        if data.get("op") == "node.remove":
            d = data.get("data") or {}
            if d.get("id") == VICTIM:
                remove_seq = data.get("seq")
                break

    # C3: no node.upsert re-creating the victim AFTER the remove.
    resurrection = None
    if remove_seq is not None:
        saw_remove = False
        for ev in events:
            if ev["event"] != "tree.op":
                continue
            data = ev["data"] or {}
            if not saw_remove:
                if data.get("op") == "node.remove":
                    d = data.get("data") or {}
                    if d.get("id") == VICTIM:
                        saw_remove = True
                continue
            if data.get("op") == "node.upsert":
                node = (data.get("data") or {}).get("node") or {}
                if node.get("id") == VICTIM:
                    resurrection = data.get("seq")
                    break

    reasons = []
    if not victim_in_snapshot:
        reasons.append("victim NOT in cold snapshot (cannot be known -> no remove)")
    if remove_seq is None:
        reasons.append("no node.remove for victim observed")
    if resurrection is not None:
        reasons.append("victim RESURRECTED by node.upsert at seq=%s" % resurrection)

    print("OK" if not reasons else "WAIT")
    print("victim_in_snapshot=%s remove_seq=%s resurrection_seq=%s events=%d"
          % (victim_in_snapshot, remove_seq, resurrection, len(events)))
    for r in reasons:
        print("REASON: " + r)


if __name__ == "__main__":
    main()
