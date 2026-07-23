#!/usr/bin/env python3
"""Generate the synthetic tree seed SQL for the docker-gold tree=2 assertions.

Emits idempotent SQL on stdout that seeds a fixed synthetic forest into the
container's opencode `session` table (applied via the `sqlite3` CLI that the
e2e image installs). The forest is shaped to exercise the tree=2 lazy frontier
(A), expand pagination (B), the missed-delete reconcile path (C), and
reconnect replay (D):

  ses_tree_root_wide   root with 60 direct leaf children  (B: expand pagination)
  ses_tree_root_deep   root of a 4-level idle chain        (A: lazy frontier /
                                                          descendantCount > childCount)
  ses_tree_idle        root with 500 idle leaf children   (A: volume so the
                                                          bounded-frontier claim
                                                          is load-bearing)
  ses_tree_victim      lone root shipped in the frontier  (C: reconcile node.remove
                                                          victim)

project_id / directory / version are derived from whatever real session already
exists in the DB (the run.sh-created e2e session), so the seeder is
self-calibrating and survives opencode upgrades. parent_id is a real column on
the opencode `session` table (NULL = root); the aggregator reads it straight off
the /session envelope, so a raw INSERT surfaces in the tree with no event
needed to build the parent/child edges.

Re-running is safe: the leading `DELETE FROM session WHERE id LIKE 'ses_tree_%'`
clears any prior seed before re-inserting, so `run.sh` does not double-seed.

Output target: stdout (SQL). Applied by run.sh via:
    docker cp <gen> "$NAME":/tmp/seed.sql
    docker exec "$NAME" sqlite3 "$DBPATH" ".read /tmp/seed.sql"
"""
import sys

# Deterministic ms epoch so created/updated are stable across runs (idempotent).
BASE = 1700000000000


def emit(sql):
    sys.stdout.write(sql + "\n")


def main():
    emit("BEGIN;")
    # Idempotency: clear any prior seed (by id prefix) before re-inserting.
    emit("DELETE FROM session WHERE id LIKE 'ses_tree_%';")

    # Self-calibrate against an existing real session so the seed matches the
    # container's actual project_id / directory / opencode version.
    project = "(SELECT project_id FROM session LIMIT 1)"
    directory = "(SELECT directory FROM session LIMIT 1)"
    version = "(SELECT version FROM session LIMIT 1)"

    cols = ("(id, project_id, workspace_id, parent_id, slug, directory, path, "
            "title, version, agent, model, time_created, time_updated, time_archived)")

    def insert(sid, parent, slug, title, tc, tu, archived=None):
        pid = "NULL" if parent is None else ("'" + parent + "'")
        arc = "NULL" if archived is None else str(archived)
        emit("INSERT INTO session %s VALUES ('%s', %s, NULL, %s, '%s', %s, '', "
             "'%s', %s, NULL, NULL, %d, %d, %s);"
             % (cols, sid, project, pid, slug, directory, title, version, tc, tu, arc))

    # --- Roots (parent_id NULL => top-level). All ship as collapsed frontier
    #     placeholders (loaded:false) on a cold tree=2 snapshot.
    insert("ses_tree_root_wide", None, "tree-root-wide", "Tree Wide Root", BASE, BASE)
    insert("ses_tree_root_deep", None, "tree-root-deep", "Tree Deep Root", BASE, BASE)
    insert("ses_tree_idle", None, "tree-root-idle", "Tree Idle Root", BASE, BASE)
    insert("ses_tree_victim", None, "tree-victim", "Tree Victim Root", BASE, BASE)

    # --- ROOT_WIDE: 60 direct leaf children. defaultTreeExpandLimit=50, so the
    #     expand endpoint returns page1=50 (hasMore) + page2=10 (terminal).
    for i in range(60):
        insert("ses_tree_wide_%02d" % i, "ses_tree_root_wide",
               "tree-wide-%02d" % i, "Wide Child %d" % i, BASE + i, BASE + i)

    # --- ROOT_DEEP: a 4-level idle chain. The whole subtree collapses to ONE
    #     frontier node on cold load (descendantCount=4 > childCount=1), proving
    #     deep idle subtrees are NOT shipped.
    prev = "ses_tree_root_deep"
    for lvl in range(1, 5):
        sid = "ses_tree_deep_%d" % lvl
        insert(sid, prev, "tree-deep-%d" % lvl, "Deep Level %d" % lvl,
               BASE + 100 + lvl, BASE + 100 + lvl)
        prev = sid

    # --- ROOT_IDLE: 500 idle leaf children. Volume so behavior A's
    #     "ship count ~= O(roots), NOT O(total)" claim is observable: the cold
    #     snapshot ships ONE node (ses_tree_idle) with childCount=500 while the
    #     500 children stay collapsed.
    for i in range(500):
        insert("ses_tree_idle_%03d" % i, "ses_tree_idle",
               "tree-idle-%03d" % i, "Idle Child %d" % i, BASE + 200 + i, BASE + 200 + i)

    emit("COMMIT;")


if __name__ == "__main__":
    main()
