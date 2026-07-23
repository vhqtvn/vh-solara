#!/usr/bin/env python3
"""Assert the tree=2 expand endpoint paginates a WIDE node (behavior B).

Reads the JSON response from `GET /vh/tree/children?id=ses_tree_root_wide[&cursor=...]`
on stdin. Mode is argv[1]: "page1" (no cursor) or "page2" (cursor from page1).

  page1: defaultTreeExpandLimit=50, so a 60-child root returns exactly 50 direct
         children with hasMore=true and a cursor; every returned node's parentId
         is the wide root and none of them is the whole subtree (no grandchildren
         / sibling roots leak through).
  page2: resuming at page1's cursor returns the remaining 10 children with
         hasMore=false (terminal batch).

On a page1 OK the cursor is printed on line 2 so run.sh can feed it to page2.
Prints "OK"/"WAIT" then diagnostics; exit 0 always.
"""
import json
import sys

WIDE = "ses_tree_root_wide"
WIDE_KIDS = {"ses_tree_wide_%02d" % i for i in range(60)}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "page1"
    try:
        d = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        print("WAIT")
        print("parse-error=%s" % e)
        return

    nodes = d.get("nodes") or []
    reasons = []

    if d.get("parentId") != WIDE:
        reasons.append("parentId=%r, want %s" % (d.get("parentId"), WIDE))

    node_ids = [n.get("id") for n in nodes]
    parent_ids = {n.get("parentId") for n in nodes}

    # Every returned node must be a DIRECT child of the wide root.
    if parent_ids != {WIDE}:
        reasons.append("returned parentIds=%s, want {%s}" % (sorted(parent_ids), WIDE))
    leaked = set(node_ids) - WIDE_KIDS
    if leaked:
        reasons.append("non-wide-child leaked: %s" % sorted(leaked)[:5])

    if mode == "page1":
        # First page: full 50, more remain.
        if len(nodes) != 50:
            reasons.append("page1 len=%d, want 50" % len(nodes))
        if not d.get("hasMore"):
            reasons.append("page1 hasMore=%r, want True" % d.get("hasMore"))
        if not d.get("cursor"):
            reasons.append("page1 missing cursor")
        if d.get("staleCursor"):
            reasons.append("page1 staleCursor=True unexpectedly")
        print("OK" if not reasons else "WAIT")
        print("page1 len=%d hasMore=%s cursor=%s"
              % (len(nodes), d.get("hasMore"), d.get("cursor", "")))
        if not reasons:
            print(d.get("cursor", ""))  # line 3: cursor for run.sh to pass to page2
        for r in reasons:
            print("REASON: " + r)
        return

    if mode == "page2":
        # Terminal page: the remaining 10, no more.
        if len(nodes) != 10:
            reasons.append("page2 len=%d, want 10" % len(nodes))
        if d.get("hasMore"):
            reasons.append("page2 hasMore=%r, want False" % d.get("hasMore"))
        if d.get("cursor"):
            reasons.append("page2 cursor=%r, want empty (terminal)" % d.get("cursor"))
        print("OK" if not reasons else "WAIT")
        print("page2 len=%d hasMore=%s" % (len(nodes), d.get("hasMore")))
        for r in reasons:
            print("REASON: " + r)
        return

    print("WAIT")
    print("unknown mode=%r (want page1|page2)" % mode)


if __name__ == "__main__":
    main()
