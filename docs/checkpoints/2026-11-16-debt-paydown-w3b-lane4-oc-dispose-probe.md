# Debt-paydown W3b — lane-4 oc-dispose SSE-forwarding proof (flow-8 probe receipt)

Card: `task-2026-11-16t16-54-05-debt-paydown-w3b-lane-4-dispatch-oc-dispose-sse-forwarding-proof-zero-code-flow-8-probe-conditional-flow-10-escalation`
(closes defer card #7 `defer-oc-dispose-sse-forwarding-proof` from
`tmp/agent-runs/defer-restudy-2026-11-16/deep-study-7.md`)

Date: 2026-11-16. HEAD `6ecde3a9144adb1fd27bee5f2994499848fc5eac` (tree clean
in `tests/e2e-docker/` + `Dockerfile.e2e`; unrelated in-flight dirt elsewhere).
Session alias `w3b-lane4-dispose-probe`. Zero code changes.

## Verdict: PROBE POSITIVE (takeover/dispose-lever arm) — flow 10 NOT-NEEDED

The defer card's forwarding question — "does a real opencode emit
`server.instance.disposed`, and does it forward through the real stack to the
vh-solara journal?" — answers **YES for the dispose-lever (R2/takeover) shape**
on real opencode **1.18.34**:

- Emit + forward proof: after `curl -sS -X POST 'http://localhost:8098/vh/reload-project' -H 'X-VH-CSRF: 1'`
  → `{"ok":true}`, `docker logs vh-e2e-real` showed

  ```
  2026-11-16T17:04:58.809411711Z time=2026-11-16T17:04:58.809Z level=INFO msg="oc instance disposed" type=server.instance.disposed directory=/work
  ```

  — `pkg/state/translate.go:336`'s journal arm firing on a REAL opencode SSE
  frame (the journal line can only log what arrived on the wire; it cannot
  synthesize `type=server.instance.disposed`). Immediately followed by a CLEAN
  EOF stream end (`event stream ended (EOF)`) and rehydrate
  (`hydrated; tailing events`) ~1.1s later — vs the SIGTERM arm's
  `unexpected EOF` cut.
- Lever wiring (zero-code): `POST /vh/reload-project` (pkg/web/server_routes.go:167
  → archive.go:1014-1034) → `pkg/opencode` Client.Dispose (client.go:375-384) →
  upstream `POST /instance/dispose`. This is the same journal arm the incident's
  R2-takeover shape exercises on every dispose.

## Negative arm (by design): SIGTERM never emits the event

Flow 8's built-in `pkill -x opencode` (SIGTERM) arm is NEGATIVE and will always
be: opencode 1.18.34 emits NO dispose event on SIGTERM — the SSE stream just
cuts (`unexpected EOF`), and opencode's own file log
(`/root/.local/share/opencode/log/opencode.log`) is silent around shutdown.
Deep-study caveat (b) confirmed empirically: lane-4 flows 8/9 as written can
never show the dispose event via their SIGTERM kills; the dispose lever is the
only arm that does. (This is why the probe added the zero-code curl on the kept
container rather than any code.)

## Receipt

| Field | Value |
|---|---|
| Command | `vh-agent-harness exec python3 .opencode/skills/bgshell-job/scripts/bgshell_job.py launch --job w3b-flow8-probe -- bash tests/e2e-docker/run.sh --keep --flow 8` |
| Outcome | exit 0, PASS (flow 8 green on its own scoped setup: SIGTERM → failed/watch-restart → healed pid 79 → retry landed once) |
| Duration | 32s total (17:00:13Z→17:00:45Z); layer cache WARM (not the 10-25min cold case); built image `sha256:b71c583062f4…` |
| opencode version | **1.18.34** (`/root/.opencode/bin/opencode --version` in container; Dockerfile.e2e unpinned install resolved to 1.18.34 today) |
| Journal lines matched | `msg="oc instance disposed" type=server.instance.disposed directory=/work` at 17:04:58.809Z (+ clean EOF + rehydrate lines) |
| Lever curl | `curl -sS -X POST 'http://localhost:8098/vh/reload-project' -H 'X-VH-CSRF: 1'` → `{"ok":true}` at ~17:04:58Z |
| HEAD binding | `6ecde3a9144adb1fd27bee5f2994499848fc5eac` |
| Raw artifacts | `tmp/agent-runs/w3b-lane4-dispose-probe/` (`bg-jobs/w3b-flow8-probe/job.log`, `real-container.log`, `real-container-final.log`) — tmp is gitignored; THIS doc is the durable record |
| Cleanup | kept container `vh-e2e-real` removed after capture (`docker rm -f`) |

## Verification

| Claim | Verifying command/output | Verified |
|---|---|---|
| Flow 8 green on real opencode | bgshell job `w3b-flow8-probe` exit 0; run.sh PASS lines in job.log | yes |
| Dispose event emitted + forwarded | `docker logs vh-e2e-real` line `msg="oc instance disposed" type=server.instance.disposed directory=/work` (17:04:58.809Z), saved in `real-container-final.log` | yes |
| Journal arm is translate.go:336 | Grep of pkg/state/translate.go at HEAD 6ecde3a (premise re-derivation) | yes |
| SIGTERM arm emits nothing | full 17-line container log at SIGTERM time (`real-container.log`) has no `disposed` string; opencode own-log silent | yes |
| opencode version 1.18.34 | `docker exec vh-e2e-real /root/.opencode/bin/opencode --version` | yes |

## Findings

- **Forwarding works end-to-end (emit→SSE→aggregator→journal)**: source=docker
  logs of real container, confidence=high, type=fact.
- **SIGTERM shape never emits `server.instance.disposed`** (SSE hard-cuts,
  unexpected EOF): source=observed container logs both arms, confidence=high,
  type=fact (scoped to 1.18.34).
- **Version drift caveat**: probe answers for 1.18.34, NOT the incident's
  1.19.5 (unpinned `curl https://opencode.ai/install`). A literal-1.19.5 answer
  would need an optional Dockerfile.e2e pin — follow-up option, deliberately
  not landed (zero-code dispatch). Confidence=high, type=fact.

## Contradictions

- Card premise "govulncheck session has Dockerfile/Dockerfile.e2e/go.mod dirty"
  was STALE at probe time: `git status --porcelain` showed only unrelated
  web/notify dirt; `tests/e2e-docker/` + both Dockerfiles clean. (Flow-10
  escalation condition (b) would have been satisfiable; moot — probe positive.)
- Mission's "~10-25 min, cache may be cold" premise: cache was WARM (32s run).
  Direction favorable; recorded as drift, not a contradiction in effect.

## Disposition

Card closable on this receipt; flow 10 NOT-NEEDED for the forwarding question.
Optional follow-ups (operator decisions, not landed here): (a) pin
Dockerfile.e2e's opencode install to answer the literal-1.19.5 form;
(b) teach lane-4 a dispose-lever flow if the SIGTERM-vs-takeover distinction
should be guarded in CI.

decision-item: task-2026-11-16t16-54-05-debt-paydown-w3b-lane-4-dispatch-oc-dispose-sse-forwarding-proof-zero-code-flow-8-probe-conditional-flow-10-escalation#measured_outcome[fnv1a:872734f4564fdc57] (curated)
