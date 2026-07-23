#!/usr/bin/env python3
"""Assert reconnect at the head cursor does NOT re-ship (behavior D-i).

Reads the RAW SSE text captured from `GET /vh/stream?tree=2` with
`Last-Event-ID` set to the head seq (the store seq the prior connection
reached) on stdin. argv[1] is that head seq. On a clean cursor-replay
reconnect the server:

  - does NOT re-ship a tree.snapshot (the cursor is valid -> no ring-gap), and
  - replays only store events with seq strictly greater than the cursor.
    A replayed op whose seq is <= the head cursor would be a DUPLICATE re-ship
    (a regression of the cursor-replay path). Genuinely-new ops (seq > head)
    landing in the tiny window between capture and reconnect are correct
    behavior, not a violation, so they are tolerated.

So the assertion is: zero tree.snapshot, AND no tree.op with seq <= head.

The ring-gap fallback half (tree.snapshot cause:"reconnect" after the head
advances past the 4096-entry ring window) is documented as infeasible in this
harness without generating >4096 store ops and is asserted in the in-process
e2e suite instead.

Prints "OK"/"WAIT" then diagnostics; exit 0 always.
"""
import json
import sys

HEAD = int(sys.argv[1]) if len(sys.argv) > 1 else None


def main():
    text = sys.stdin.read()
    snapshots = 0
    new_ops = 0          # tree.op with seq strictly > head (correct replay)
    dup_ops = 0          # tree.op with seq <= head (DUPLICATE re-ship -- bug)
    dup_details = []
    other_event_lines = []
    want_data = False     # track data line after an event: tree.op
    for line in text.splitlines():
        if line.startswith("event:"):
            kind = line.split(":", 1)[1].strip()
            want_data = (kind == "tree.op")
            if kind == "tree.snapshot":
                snapshots += 1
            elif kind not in ("tree.op", "tree.snapshot", ""):
                other_event_lines.append(kind)
            continue
        if want_data and line.startswith("data:"):
            want_data = False
            try:
                payload = json.loads(line.split(":", 1)[1].strip())
            except Exception:
                continue
            seq = payload.get("seq")
            try:
                seq_i = int(seq) if seq is not None else None
            except (TypeError, ValueError):
                seq_i = None
            if seq_i is None:
                continue
            if HEAD is not None and seq_i <= HEAD:
                dup_ops += 1
                dup_details.append("seq=%d (head=%d)" % (seq_i, HEAD))
            else:
                new_ops += 1

    reasons = []
    if snapshots != 0:
        reasons.append("tree.snapshot re-shipped on head reconnect: %d (want 0 -- no ring-gap)" % snapshots)
    if dup_ops != 0:
        reasons.append("DUPLICATE tree.op re-shipped (seq <= head %s): %s"
                       % (HEAD, ", ".join(dup_details)))

    print("OK" if not reasons else "WAIT")
    print("snapshots=%d dup_ops=%d new_ops=%d head=%s other_events=%s"
          % (snapshots, dup_ops, new_ops, HEAD,
             sorted(set(other_event_lines))))
    for r in reasons:
        print("REASON: " + r)


if __name__ == "__main__":
    main()
