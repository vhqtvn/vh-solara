# Phase 0 — harness hygiene verification + dispatch-seam localization (2026-08-16)

Session: `land-slice1-harness-lifecycle` (brief-1 Slice S1 execution).
Sources of truth: `tmp/agent-runs/sb-harness-waste_2026-08-15/brief.md` (staged
O4→O1→O2 plan), `tmp/agent-runs/sb-overlay-vs-upstream_2026-08-16/brief.md`
(ownership doctrine, Phase 0 = Slice 0A + 0B).

Baseline: `vh-agent-harness version` → `0.25.0 (f4b9842)`; `vh-agent-harness
doctor` → `HEALTHY` (0 problems; 1 pre-existing advisory warning on file-size
complexity, unrelated). This doc gates future S5/S6 dispatches. It records
findings only — no fixes landed here (Phase 0 is verify/localize by contract).

## 0A — hygiene verification (verify-only)

| # | Item | Verdict | Receipt (command → outcome) |
|---|------|---------|------------------------------|
| 1 | Read-only git exempt from `git-mutation-bypass` | **fixed-upstream** | Positives all pass through the harness exec path: `vh-agent-harness exec git log --oneline -3` → 3 commits printed; `… git status` → branch+status printed; `… git diff --stat` → 1-file stat printed; `… git merge-base --is-ancestor HEAD HEAD` → exit 0. Negatives all deny: `… git branch -t __perm_probe_branch`, `… git merge-file __probe_a __probe_b __probe_c`, `… git update-index --add __probe_nonexistent_path` → each blocked by shell-guard rule `git-mutation-bypass` ("Git mutations must go through the commit-gate wrapper. Only the committer agent…"). |
| 2 | Repo-root path normalization (in-repo relative + repo-root-resolved forms) | **fixed-upstream** for the audited complaint (no false denial/prompt on in-repo forms) — with one scope observation below | `vh-agent-harness exec bash -c 'sed -n 1p web/package.json'` (root-relative) → `{`; `… 'cd web && sed -n 1p package.json'` (subdir-relative inside exec) → `{`; `… 'sed -n 1p "$PWD/web/package.json"'` (repo-root-resolved absolute) → `{`. All three equivalent in-repo forms behave consistently; no `external_directory` prompt or false denial reproduced. Observation (NOT the audited bug): out-of-repo reads are currently *permissive* on both surfaces probed — `vh-agent-harness exec bash -c 'sed -n 1p /etc/hostname'` and `sed -n 1p ../../../../etc/hostname` (wrapped) and raw `sed -n 1p /etc/hostname` (unwrapped) all executed and printed the hostname. The historical `external_directory` prompt mechanism did not fire for read-only `sed` in this session's permission profile. No in-repo false denial exists to fix; the out-of-repo read posture is a permission-profile property, recorded for S5 disposition only. |
| 3 | Commit-gate cleanup ownership (success/release/no-change/orphan) | **fixed-upstream** (gate-owned; no cleanup verb exposed) | Inspection of `.opencode/scripts/commit-gate.sh` (Read tool): success paths (`cmd_commit`, l.1356–1360 and l.1388–1391) and `no_changes` (l.1012–1013) call `_cleanup_own_scratch` + `_gate_gc_sweep`; `cmd_release` calls them on both the no-lock (l.1443–1444) and lock-held (l.1472–1473) branches; aged-orphan GC sweeps `msg-/paths-/meta-/index-/merge-` prefixes plus agent-owned `tmp/commit-gate-message/msg-*` with age gate + protected-UUID skip; caller-controlled `--message-file` reclamation is fenced by `_safe_msg_reclaim_path` (must lexically normalize to `tmp/commit-gate-message/msg-*`; absolute and `..` rejected) and `_session_meta_path` uuid charset guard. `.opencode/scripts/readonly-scripts.sh` exposes exactly two verbs — `gen-uuid`, `prep-tempdir` — no deletion verb. Per brief-2: no new cleanup verb added (REJECT stands). |
| 4 | `vh-agent-harness exec npm --prefix web run <script>` denial | **not-reproduced** (concern closed) | `vh-agent-harness exec npm --prefix web run __perm_probe_nonexistent` → passed the permission/parse layer and reached npm, which failed with its own `npm error Missing script: "__perm_probe_nonexistent"` (exit 1). The sanctioned shape parses and matches; there is no denial to fix. No real web lanes were run. |
| 5 | `docs/ai/shell-execution.md` absent while referenced | **record-only** (documentation gap; separate docs slice) | Glob `docs/ai/*.md` → the file does not exist (5 other files present). Referenced by `AGENTS.md` 3× (l.86, l.126, l.174) and `.opencode/plugins/shell-guard-core.js` 3× (l.1296, l.1423, l.1513). No runtime bug inferred — the shell-guard rules themselves work (item 1 receipts prove deny+allow both fire correctly). |

### Deny that fired during 0A (transparency)

Grepping `commit-gate.sh` through `vh-agent-harness exec` (even read-only
`grep -n`) is blocked by a name-based guard ("Gate wrapper must be invoked
directly, not through vh-agent-harness exec"). Not evaded — the file was
inspected with the Read tool instead, which is the canonical read path.

## 0B — dispatch retry-storm seam localization (localization ONLY; fix = S6)

### Ledger evidence (reconciled with the 2026-08-10 audit)

Read-only queries against the opencode session database
(`$XDG_DATA_HOME/opencode/opencode.db`, conventionally
`~/.local/share/opencode/opencode.db` — adapt per machine); scripts retained
under `tmp/agent-runs/land-slice1-harness-lifecycle/probe_storm*.py`. The
condensed re-derivation queries:

```sql
-- storm census + reconciliation
SELECT parent_id, agent, title, COUNT(*) FROM session
WHERE title LIKE '%Inv1-A%' GROUP BY parent_id, agent, title;
-- the 119-call single message (task-tool error census)
SELECT p.message_id, json_extract(p.data,'$.state.status'), COUNT(*)
FROM part p WHERE p.session_id = 'ses_076bdc20affeEpSJmhAOwbFPXq'
  AND p.time_created BETWEEN 1786345800000 AND 1786346800000
  AND json_extract(p.data,'$.tool') = 'task' GROUP BY 1, 2;
```

- 126 sessions match `title LIKE '%Inv1-A%'` on 2026-08-10; 121 are `build`
  children; **119 are titled exactly `Fix Inv1-A ordinal mismatch (@build
  subagent)`** — the audit's "120 duplicate sessions, 119 near-empty"
  reconciles as 119 errored duplicates + 1 successful re-dispatch
  (`Fix Inv1-A O3 ordinal defects`, completed 07:18:12Z).
- All 125 task-children share ONE parent: `ses_076bdc20affeEpSJmhAOwbFPXq`
  (agent `coordination`, opencode **v1.18.4**, 457 messages).
- All 120 `task` tool calls of the storm live in **ONE assistant message**
  (`msg_fea80e106001x7GTnRADe7Js04`, model glm-5.2-high): 119 `status=error`
  (`"error": "Task cancelled"`, each with a distinct child `sessionId` in
  metadata — a child session was created per streamed call) + bursts 15–20 ms
  apart from 07:10:57Z to 07:14:31Z, then the message terminates with
  `MessageAbortedError` (operator/tooling abort; parallel `todowrite` calls in
  the same message show `"Tool execution aborted"`, `interrupted: true`).

### Authoritative seam (owner, call path, state transitions)

- **Trigger layer (emission):** the parent session's model generation inside
  OpenCode core's agent loop — a single streaming assistant message degenerated
  into emitting the SAME `task` tool_use block 119 times (parallel-call
  amplification within one message), each parsed and executed as it streamed.
  This is NOT model-HTTP retry code (different boundary, per brief-2 E20) and
  NOT any harness plugin.
- **Child-session-creation owner:** **OpenCode core's task-tool executor**
  (external to this repo; opencode v1.18.4 at incident time). Call path:
  streamed tool_use → task executor → child session INSERT (opencode.db) →
  child agent boot → abort cancels in-flight children → near-empty child
  session rows persist (no dedupe, no per-message identical-call cap, no
  cancelled-child reaping).
- **State transitions observed:** `emitted (N× identical in one message)` →
  `child-created (per call)` → `Task cancelled (MessageAbortedError)` →
  `orphan persisted (created≈updated, near-empty)` → fresh single re-dispatch
  next turn → `completed`.

### External-boundary statement + examination inventory

The dedupe/backoff fix belongs at the OpenCode-core task executor / agent-loop
boundary (external upstream). Examination inventory of every local candidate:
1. Rendered harness plugins `.opencode/plugins/*.js` — only `pause-new-work.js`
   touches the task tool, and only to BLOCK dispatch under an engaged
   repo-scoped pause (`tool.execute.before`, `input.tool === "task"`). No
   plugin emits, retries, or dedupes task calls.
2. `.vh-agent-harness/` sources — no dispatch/child-session creation code
   (grep for retry/backoff/dispatch matched prose only).
3. `.opencode/state/` — session/bookkeeping state only; no dispatch logic.
4. vh-solara app code — drives opencode via send/spawn verbs, but this
   incident's parent→child chain lives entirely inside opencode's own session
   tree (task-tool subagents); the app's retry code is model-HTTP (different
   boundary). Not the seam for this incident.

**Actionable localization nugget for S6:** `pause-new-work.js` proves a LOCAL
pre-execution interception seam exists — `tool.execute.before` with
`input.tool === "task"` fires BEFORE opencode core creates the child. A
dedupe/backoff guard could be piloted there as a harness plugin (upstreamable),
while the authoritative child-creation boundary remains opencode core.

### Interim mitigation choreography (from brief-2 §5; guidance only)

Stable logical dispatch identity per task/slice; dispatch sequentially (no
parallel identical task emissions); inspect existing children before at most
ONE manual retry; never auto-spawn on ambiguous failure. These land as
guidance in the S1 lifecycle doc (`docs/ai/` + rendered sources), not as code.

## Verification

| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Harness version 0.25.0 | `vh-agent-harness version` → `0.25.0 (f4b9842)` | yes |
| Doctor healthy at baseline | `vh-agent-harness doctor` → `result: HEALTHY` | yes |
| Read-only git forms pass | 4 positive probes via `vh-agent-harness exec git …` (see 0A-1) | yes |
| Adjacent git mutations deny | 3 negative probes blocked by `git-mutation-bypass` | yes |
| In-repo path forms consistent | 3 equivalent forms all read `web/package.json` | yes |
| Cleanup gate-owned | Read-tool inspection of commit-gate.sh call sites | yes |
| readonly-scripts has no deletion verb | Read-tool inspection (2 verbs only) | yes |
| npm --prefix denial not reproducible | probe reached npm (`Missing script` error) | yes |
| docs/ai/shell-execution.md absent | glob + grep refs | yes |
| Storm = one message, 119 identical task calls, one parent | opencode.db read-only queries (probe_storm*.py) | yes |
| No local dispatch/dedupe code in harness | grep inventory of plugins + .vh-agent-harness | yes |

## Findings

- **0A-1..0A-4 all verify as already fixed / not reproducible**: source=live
  probes on harness 0.25.0, confidence=high, type=fact. Consequence: S5's
  original item list shrinks to (a) Go-PATH ergonomics (unchanged, documented
  workaround stands) and (b) the out-of-repo read posture observation — both
  need an operator disposition before any S5 work is dispatched.
- **0A-5 documentation gap**: source=glob+grep, confidence=high, type=fact.
  Fix belongs to a separate docs slice (brief-2 §6), not S5 runtime work.
- **0B seam localized**: source=opencode.db ledger, confidence=high,
  type=fact. The storm is single-message parallel amplification + abort, owned
  by opencode core (external); a local `tool.execute.before` interception seam
  exists and is the S6 pilot candidate.

## Contradictions

- Audit phrased the storm as a "retry storm"; ledger shows it is not a retry
  loop but single-message parallel amplification (119 identical streamed
  tool_use in one assistant message). The audit's counts reconcile exactly
  (119 near-empty + 1 completing re-dispatch = "120 sessions"). Brief-2 E20's
  "model-HTTP retry code is a different boundary" is confirmed — that code is
  not involved.

<!-- behavioral-closure
deliverable: phase0-verification-doc
crux: verify-only hygiene probes + dispatch-seam localization against installed harness 0.25.0 and opencode.db ledger
verifier: probe commands + read-only sqlite queries recorded above
verdict: proven
result: proven
receipt: probe commands in 0A table (allow/deny outcomes) + probe_storm*.py outputs (126/121/119 session counts, single-parent, single-message 119-task-call amplification, MessageAbortedError) bound to harness 0.25.0 (f4b9842) / opencode v1.18.4 ledger on this machine, 2026-08-16
-->
