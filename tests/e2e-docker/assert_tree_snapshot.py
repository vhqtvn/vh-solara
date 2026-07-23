#!/usr/bin/env python3
"""Assert the cold tree=2 snapshot ships a BOUNDED frontier (behavior A).

Reads the RAW SSE text captured from `GET /vh/stream?tree=2` on stdin, finds the
first `event: tree.snapshot` payload, and asserts:

  A1. the frontier node count is BOUNDED and much smaller than the seeded total
      (~568 sessions). A cold load ships O(roots + active-path + direct-children-
      of-loaded); with the seeded forest all idle that is just the roots, so the
      count must be in the low tens at most -- never hundreds/thousands.
  A2. a collapsed deep idle subtree ships as ONE placeholder: ses_tree_root_deep
      is present with loaded:false, descendantCount present, and
      descendantCount > childCount (childCount=1, descendantCount=4).
  A3. the deep chain BELOW the root (ses_tree_deep_2/3/4) is NOT shipped -- the
      subtree is collapsed, not eagerly walked.
  A4. the volume root ses_tree_idle is present with childCount=500 while its 500
      leaf children are NOT shipped (proving ship count is independent of total).

Prints "OK"/"WAIT" then diagnostics; exit 0 always (caller controls retries).
"""
import json
import sys

# The cold frontier for the seeded forest (4 tree roots + the run.sh e2e root +
# any incidental children of an active root) is a handful of nodes. Allow head-
# room for the live e2e session's subtree but stay far below the seeded total.
BOUND = 40
SEEDED_TOTAL = 568  # 4 roots + 60 wide + 4 deep + 500 idle


def first_snapshot_data(text):
    """Return the parsed JSON of the first tree.snapshot event, or None."""
    want = False
    for line in text.splitlines():
        if line.startswith("event:"):
            want = line.split(":", 1)[1].strip() == "tree.snapshot"
            continue
        if want and line.startswith("data:"):
            payload = line.split(":", 1)[1].strip()
            try:
                return json.loads(payload)
            except Exception:
                return None
    return None


def main():
    text = sys.stdin.read()
    snap = first_snapshot_data(text)
    if snap is None:
        print("WAIT")
        print("no tree.snapshot event parsed")
        return

    nodes = snap.get("nodes") or []
    by_id = {n.get("id"): n for n in nodes}
    ids = set(by_id)

    deep_root = by_id.get("ses_tree_root_deep")
    idle_root = by_id.get("ses_tree_idle")
    deep_chain = {"ses_tree_deep_2", "ses_tree_deep_3", "ses_tree_deep_4"}
    idle_kids = {"ses_tree_idle_%03d" % i for i in range(500)}

    reasons = []

    # A1: bounded frontier.
    if len(nodes) > BOUND:
        reasons.append("frontier not bounded: %d nodes > %d" % (len(nodes), BOUND))

    # A2: deep root collapsed placeholder with descendantCount > childCount.
    if deep_root is None:
        reasons.append("ses_tree_root_deep missing from snapshot")
    else:
        dc = deep_root.get("descendantCount")
        cc = deep_root.get("childCount")
        if deep_root.get("loaded") is not False:
            reasons.append("deep root loaded=%r, want False" % deep_root.get("loaded"))
        if dc is None:
            reasons.append("deep root missing descendantCount (collapsed badge)")
        if cc != 1:
            reasons.append("deep root childCount=%r, want 1" % cc)
        if dc is not None and cc is not None and not (dc > cc):
            reasons.append("deep root descendantCount(%r) not > childCount(%r)" % (dc, cc))

    # A3: deep chain below the root NOT shipped.
    leaked_deep = ids & deep_chain
    if leaked_deep:
        reasons.append("deep chain leaked into frontier: %s" % sorted(leaked_deep))

    # A4: idle volume root present, its 500 children NOT shipped.
    if idle_root is None:
        reasons.append("ses_tree_idle missing from snapshot")
    else:
        if idle_root.get("childCount") != 500:
            reasons.append("idle root childCount=%r, want 500" % idle_root.get("childCount"))
    leaked_idle = ids & idle_kids
    if leaked_idle:
        reasons.append("idle children leaked into frontier: %d (e.g. %s)"
                       % (len(leaked_idle), sorted(leaked_idle)[:3]))

    print("OK" if not reasons else "WAIT")
    print("frontier_nodes=%d seeded_total=%d bound=%d" % (len(nodes), SEEDED_TOTAL, BOUND))
    if deep_root:
        print("deep_root loaded=%s childCount=%s descendantCount=%s"
              % (deep_root.get("loaded"), deep_root.get("childCount"),
                 deep_root.get("descendantCount")))
    print("deep_chain_shipped=%s idle_children_shipped=%d"
          % (sorted(ids & deep_chain), len(ids & idle_kids)))
    for r in reasons:
        print("REASON: " + r)


if __name__ == "__main__":
    main()
