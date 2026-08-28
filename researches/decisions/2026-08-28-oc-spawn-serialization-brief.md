# Solution Brief: Detached OpenCode Spawn Serialization

> NOTE: Promoted from tmp/agent-runs/oc-spawn-serialization-brief/brief.md to researches/decisions/2026-08-28-oc-spawn-serialization-brief.md
> Date: 2026-08-28
> Context: Backlog card P1-API-002; follows commit eb03548 split-brain guard.
> Operator-accepted decisions: two-role flock; ExtraFiles; orphaned-owner = report-never-auto-spawn; both DEFERs folded into the implementation slice.
> Implementation was dispatched against these records.

**Date:** 2026-08-28  
**Mode:** read-only compare-and-plan  
**Decision status:** accepted (operator-accepted 2026-08-28 — see outcome note below)  
**Framing confidence:** unknown at kickoff; unchanged. The recommendation is therefore phased rather than falsely settled.

## 1. Decision frame

### Objective

Serialize detached OpenCode startup across concurrent vh-solara daemon processes so two cooperating starters can never both spawn against the same project database, including the hard crash window after the first starter has created the child but before it has published `ocState`.

### Constraints and invariants

1. Preserve p1-oc-001 decoupling: lock contention, lock failure, or an unavailable OpenCode must produce failed OpenCode lifecycle state while the vh worker continues serving. No indefinite boot wait.
2. Preserve `classifyOCInstance` authority: only a live PID whose `/proc/<pid>/cmdline` matches the recorded OpenCode port prevents spawning. An HTTP probe never grants spawn authority.
3. Preserve stable-port reuse and `ocState` semantics: state is written only after successful startup; the Occupied path does not alter state; restart continues to target the recorded PID and port, but must validate identity before signaling.
4. Linux-specific mechanisms are acceptable, but filesystem and portability limits must be explicit.

### Exact question

What continuously held, cross-process ownership token can cover:

`acquire → read/classify → choose port → Start child → parent-crash window → readiness → publish state`

without allowing a second starter to spawn, while still providing bounded loser behavior and eventual recovery after the real OpenCode owner exits?

## 2. Verified current code shape

| Finding | Evidence |
|---|---|
| Both detached startup sites independently execute classify, port selection, child `Start`, readiness wait, and state publication. | `cmd/client-daemon-vh.go:74-147`; `cmd/local-server.go:97-161` |
| Spawn authority is PID liveness plus Linux command-line match; HTTP only separates Reattach from Occupied. | `cmd/opencode_detached.go:109-210`; `cmd/opencode_detached_test.go` |
| State is stored under the vh state base as `opencode/<sha1(cwd)>.json`, not in the repository's `.vh-solara/` directory. | `cmd/opencode_detached.go:34-63`; `README.md:348-360` |
| `writeOCState` uses temporary-write plus rename but currently discards publication errors. | `cmd/opencode_detached.go:63-74,101-107` |
| `portFree` binds and immediately closes the socket. It is a check, not a reservation. | `cmd/opencode_detached.go:256-263` |
| The configured worst classification path is approximately 13 seconds, followed by a readiness wait bounded at 30 seconds. The 13-second figure is derived, not measured. | `cmd/opencode_detached.go:183-253`; `cmd/client-daemon.go:205-217` |
| Both restart paths reread state and signal the stored PID without rechecking that it is still the matching OpenCode process. | `cmd/client-daemon-vh.go:390-413`; `cmd/local-server.go:237-258` |
| Classification semantics have co-located tests, but there is no outcome test for two real competing starter processes or the two runtime/Cobra wiring arms. | `cmd/opencode_detached_test.go`; `tests/integration/opencode_lifecycle_test.go`; backlog P1-API-002 |

### Corrected location assumption

The exclusion object should be keyed exactly like `ocState` and placed beside it under the vh state base, not under the project's committed/runtime `.vh-solara/` directory. Putting it in the workspace could introduce remote-filesystem or differing-mount visibility problems and would not match the current state identity boundary.

## 3. Mechanism comparison

| Option | Normal-path exclusion | Parent crash after child Start, before state | Stale/recovery behavior | Latency/systemd behavior | Verdict |
|---|---|---|---|---|---|
| **O1: Parent-held `flock`** across classify → Start → wait → write | Good among cooperating live parents. | **Fails.** Parent death closes its descriptors and releases the lock while the intentionally detached child may remain alive and unrecorded. A second starter can spawn. | Kernel auto-release avoids stale parent locks on local Linux filesystems. NFS/SMB behavior is conditional. | A blocking loser could wait roughly 43 seconds; nonblocking failure is required. `KillMode=process` makes the orphan window operationally relevant. | Reject for the stated “never” requirement. |
| **O1b: Child inherits the parent's locked file description; parent unlocks after state write** | Initially promising because the child survives parent death with the inherited descriptor. | Parent SIGKILL before publication can leave the child holding the lock. | Descendant FD propagation could cause fail-closed availability loss. | Nonblocking losers can keep serving failed state. Linux-specific. | **Blocked by a semantic contradiction:** `LOCK_UN` by the parent unlocks the shared open-file description, also removing the child's lock. The proposed normal completion cannot retain child ownership. |
| **Corrected child close/reopen/reacquire protocol** | Could separate parent and child lock ownership. | Not proven. Closing the inherited description before acquiring a new one creates a release/reacquire interval; acquiring first may conflict with the parent's existing exclusive lock. | Unknown until experimentally characterized with the exact primitive. | Linux-specific; may need a pre-exec shim. | Do not approve without a continuous-handoff proof. |
| **O2: `O_EXCL` lease/pidfile with liveness and staleness detection** | Atomic initial claim is straightforward. | **Fails alone.** There remains a crash interval after child creation and before durable child identity publication. | Safe recovery must handle PID reuse and cannot use elapsed time alone without weakening ownership. Ambiguous leases become availability failures. | Bounded contention is easy, but the recovery state machine is larger and systemd can expose the post-Start gap. | Reject standalone; metadata may complement another ownership primitive but must never authorize takeover. |
| **O3: Dedicated per-project guardian/supervisor** | Centralizes all ensure/restart requests and removes duplicated starter logic. | Potentially strongest, but the guardian itself still needs a continuously held token or a safe relationship to the child if the guardian can die after spawn. | Adds process lifecycle, IPC, versioning, and orphan management. | Immediate “startup in progress” responses are possible; systemd placement becomes a product-level concern. | Re-evaluate only after defining a continuous guardian/child ownership protocol. Disproportionate unless smaller primitives fail. |
| **O4: SQLite locking or stable TCP-port arbitration** | Does not establish singleton service ownership. | Does not close the gap. | SQLite serializes incompatible transactions, not service lifetime. `portFree` releases its socket before OpenCode binds, and starters can select different ports. | Cheap but late, unpredictable failures; no bounded ownership verdict. | Reject. |
| **Additional Linux candidates: OFD locks, abstract Unix socket, pidfd, pre-exec shim** | Not yet established. | Must be tested specifically for continuous ownership through exec and parent death. | Each has different ownership semantics; pidfd observes process lifetime but is not itself a cross-process exclusion claim. | Could remain Linux-only and local-host-only, which is acceptable if explicit. | Focused evidence refresh required; no presumption of viability. |

## 4. Debate outcome

### Recommendation

Do **not** implement plain `flock`, the originally proposed inherited-`flock`/parent-unlock protocol, an `O_EXCL` lease, SQLite arbitration, or port arbitration as the final answer. The evidence supports rejecting those forms, but it does not yet support selecting a replacement.

The immediate recommendation is a bounded Linux experiment and source-inspection pass to identify or refute a continuously held ownership protocol. Re-run the mechanism debate after that evidence exists. If no kernel primitive or pre-exec protocol can provide gap-free handoff, the design should step up to a guardian/supervisor architecture rather than weaken “never” with a timed lease takeover.

### Key objection that changed the leader

The researcher initially favored child-inherited `flock` plus an explicit parent unlock after state publication. Debate correctly identified that inherited descriptors refer to the same locked open-file description. Explicitly unlocking through the parent's duplicate unlocks that shared lock; the child does not retain an independent lock. A close/reopen/reacquire repair introduces an unproven handoff interval. The original leader is therefore not implementation-ready.

### Confidence

- **High:** parent-only `flock`, standalone leases, SQLite, and `portFree` cannot meet the absolute crash-window requirement.
- **Medium:** the inherited-`flock` protocol as originally stated is invalid because of shared-unlock semantics.
- **Low/unknown:** which replacement primitive or guardian protocol is smallest and sufficient. This is the named material evidence gap.

## 5. Critical-section and API scope once a mechanism is selected

The eventual shared operation should own the entire cooperating-starter transaction:

1. Derive the existing project key and exclusion path beside `ocStatePath`.
2. Attempt bounded/nonblocking ownership acquisition before reading state.
3. Under ownership, reread state and call `classifyOCInstance`; never cache a pre-lock verdict.
4. For Reattach or Occupied, preserve existing verdict semantics and release according to the selected ownership protocol.
5. For NoState or Foreign, perform stable-port reuse/check, child creation, readiness wait, and final state publication inside the protected protocol.
6. Treat state-publication failure as a real startup failure. Do not release into an unrecorded-live-child window unless the selected child/guardian ownership mechanism still excludes competitors.
7. Return a structured result such as Reattached, Occupied, Spawned, Contended, or Failed. The two runtime call sites retain only lifecycle/log/topology wiring.
8. Route future detached starters through this operation rather than copying the sequence.

The loser path must never spawn and must not block for the winner's possible ~43-second path. It should set failed lifecycle state with a diagnostic “startup already in progress/ownership contended” reason and allow vh-solara to continue serving.

## 6. Fold-in decision

### Boot-seam verdict-arm wiring test: fold in

The serialization slice necessarily consolidates or rewires the two current startup arms. A helper-only test would not prove that both runtime entry paths map Occupied, Contended, and startup errors to `ocLife.SetFailed`/continue-serving behavior without accidentally spawning or exiting. The named DEFER tests the exact seam being changed.

### Restart PID/cmdline re-verification: fold in

Restart must share the same per-project ownership domain or it can race initial startup/state publication. After acquiring ownership, it should reread `ocState` and immediately revalidate PID liveness plus `ocCmdlineMatches(st.PID, st.Port)` before signaling. A mismatch must fail safely without signaling the recycled PID. This is direct preservation of the existing ownership invariant, not unrelated cleanup.

The code changes should still be ordered as separately reviewable slices inside one task: ownership primitive/protocol first, shared startup transaction second, restart integration third, then boot/integration tests.

## 7. Required evidence-refresh brief

### Exact question

Can Linux provide a continuously held, locally visible exclusion token covering pre-spawn acquisition through child lifetime when the parent may be SIGKILLed immediately after `Start`, without a release/reacquire interval and without normal completion accidentally unlocking the child's token?

### Phase 1 — source and primitive inspection

- Inspect Go `os/exec.Cmd` descriptor propagation and `ExtraFiles`/close-on-exec behavior.
- Distinguish BSD-style `flock`, POSIX record locks, and Linux OFD locks.
- Examine whether a pre-exec shim can acquire an independent token before the parent-held token is released, without self-conflict or a visibility gap.
- Assess abstract Unix-domain socket binding as an ownership token.
- Assess pidfd only as process identity/lifetime evidence; do not assume it provides exclusion.
- Trace the actual OpenCode launch path far enough to determine whether supplied descriptors can be controlled and whether OpenCode or descendants may retain them.

### Phase 2 — tmp-only Linux experiments

Create minimal Go helpers under `tmp/agent-runs/<alias>/`:

- starter A acquires the candidate token and spawns a long-lived fake OpenCode child;
- starter A can be paused and SIGKILLed at exact phase barriers;
- child performs exec and optional descendant spawn;
- starter B repeatedly attempts nonblocking ownership and records whether it could enter;
- shared spawn counter records the user-relevant outcome, not merely lock syscall results;
- starter C proves recovery only after the actual owner exits.

Required crash points:

1. before child Start;
2. immediately after successful Start, before readiness;
3. after readiness, before state publication;
4. after state publication, before normal ownership transition/release;
5. state-publication failure;
6. child exit and descendant-FD-retention cases.

### Phase 3 — re-rank mechanisms

Return a source/experiment packet comparing:

- any corrected continuously held FD/OFD protocol;
- abstract Unix socket ownership;
- pre-exec shim designs;
- guardian/supervisor designs;
- diagnostic lease metadata as a non-authoritative companion.

If every smaller primitive has a gap, explicitly recommend the guardian class. Do not substitute a timeout-based lease takeover for proof.

## 8. Decision gates

1. **Continuous ownership:** starter B never acquires while the fake OpenCode owner remains alive, at every crash barrier.
2. **Normal completion:** state can be successfully published without unintentionally releasing the ownership needed to cover any remaining unrecorded-child risk.
3. **Recovery:** after the true owner exits, a later starter can acquire without manual stale-file cleanup.
4. **Bounded loser:** contention returns promptly and can be mapped to failed lifecycle while the daemon remains healthy.
5. **Identity safety:** no PID-only or elapsed-time-only takeover authority.
6. **Filesystem contract:** local-state assumptions and unsupported NFS/SMB/overlay mount configurations are explicit.
7. **Stop condition:** if no small primitive passes the crash matrix, choose a guardian/supervisor architecture and define its own crash-safe ownership token before implementation.

## 9. Eventual implementation shape (provisional, not approved)

### Likely files

- `cmd/opencode_detached.go` — ownership abstraction, shared startup transaction, state-write error propagation.
- `cmd/client-daemon-vh.go` — replace duplicated startup arm; route restart through shared ownership and PID/cmdline revalidation.
- `cmd/local-server.go` — same startup and restart integration.
- `cmd/opencode_detached_test.go` — primitive/protocol, subprocess competition, crash matrix, and restart identity tests.
- `tests/integration/opencode_lifecycle_test.go` or a tightly scoped sibling — loser continues serving health and failed OpenCode status.
- Potential Linux/non-Linux implementation files if build tags are required, names to be chosen only after mechanism selection.
- Relevant docs for Linux/local-filesystem support semantics and startup failure behavior.

### Estimated slice shape

Provisional estimate after mechanism selection: **5-7 source/test/doc files**, roughly **8-12 focused test cases/subtests**. A guardian decision would increase both file and test count materially and should be re-estimated rather than hidden inside this estimate.

### Ordered slices

1. Prove and implement the selected ownership primitive/protocol behind a narrow abstraction; add real subprocess and crash-release tests.
2. Make `writeOCState` return errors and implement one shared detached-start transaction.
3. Switch both startup arms to the shared result contract; add boot-seam wiring tests.
4. Serialize restart and revalidate PID plus command line immediately before signaling; add recycled-PID tests.
5. Add integration outcome proof that a contending loser stays healthy and reports OpenCode failed.
6. Update operational docs and run full verification.

### Future verification commands — not run in this read-only brief

Per slice:

```bash
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./cmd/'
```

Targeted integration after the loser lifecycle slice:

```bash
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/integration/'
```

Full Go suite only after the design is selected and all slices are integrated:

```bash
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./...'
```

Formatting check:

```bash
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && gofmt -l pkg cmd main.go'
```

### Behavioral-closure crux

The load-bearing outcome is not “a lock syscall returned contention.” It is:

> Two independently launched starter processes share the same cwd/state key; starter A is forcibly killed after child Start but before state publication; exactly one fake OpenCode child exists; starter B does not spawn and its vh process remains serving failed OpenCode status; after the owner child exits, starter C can spawn.

A proven closeout requires an inspectable receipt for the exact command, outcome, and assessed revision/tree. Helper-level lock assertions are mechanism evidence only.

## 10. Non-goals

- Do not weaken “never” into a probabilistic or timeout-based lease takeover.
- Do not let HTTP readiness authorize spawning.
- Do not use SQLite transaction locks or `portFree` as singleton ownership.
- Do not redesign the `ocState` schema used by UI restart unless later evidence proves unavoidable.
- Do not change attached OpenCode mode or unrelated daemon lifecycle behavior.
- Do not implement source changes before the continuous-ownership evidence gap is closed and debate is rerun.

## 11. Contradictions and unresolved assumptions

### Contradictions

1. The requested example location “under the project's `.vh-solara/` state dir” does not match current code. Detached OpenCode state uses the vh state base keyed by cwd hash.
2. Plain parent-held `flock` has kernel crash release but does not protect an intentionally detached child after the parent dies.
3. Child-inherited `flock` plus parent `LOCK_UN` does not create independent child ownership; the unlock applies to the shared open-file description.

### Unverified assumptions

- Whether the actual OpenCode runtime retains, closes, or propagates supplied descriptors into descendants.
- Whether a Linux OFD-lock, abstract-socket, or pre-exec-shim protocol can provide gap-free ownership with clean recovery.
- Overlayfs behavior when two daemons see the vh state directory through different mount namespaces/layers.
- The ~13-second classify duration is derived from configured attempts/timeouts, not measured under production load.
- The researcher did not find a committed `refs/opencode/` tree despite a code comment referring to it.

## 12. Next recommended command

Run a focused researcher refresh using the Phase 1-3 packet above, with tmp-only Linux experiments, then feed only its evidence register and viable candidates back into an evidence-bound debate. Do not start `build` yet.

## Outcome (2026-08-28)

The experiment (researches/decisions/2026-08-28-oc-spawn-lock-experiment.md) validated the two-role flock mechanism (ExtraFiles + close-without-unlock), guardian rejected; operator accepted; implementation dispatched as backlog card P1-API-002.
