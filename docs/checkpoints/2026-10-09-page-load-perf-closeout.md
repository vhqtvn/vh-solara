# Page Load Perf Program Closeout

## Program shape
The page-load performance program in vh-solara is COMPLETE. All slices landed, reviewed, and committed locally.
- S1 (`e98a0fba`): immutable caching for hashed assets, strong ETags + 304s, precomputed gzip for text statics
- S2 (`4d653b5a`): SW in-flight GET coalescing, /oc/* TTL/SWR, shell TTL 30s network-first
- S2b (`3379526e`): early SW registration moved to module-eval; shell cache-mode bypass; storm-safety proven
- S3a (research): X1–X6 engine-semantics experiments; 58 receipts, 3 engines
- S3b (`993477e`): host holds /app-scope registration; pane src gated on active worker; BORN SW-controlled
- X5 (research): hop attribution; decomposed cold-TTI residual; verdict: close program
- Final suite + lane-4 fix (`e726b4e`): nine-lane verification; Dockerfile.e2e hostbuild COPY web/src/themeCatalog.ts fix

## Headline numbers 
*All numbers MEASURED on the perf harness substrate — RTT 110+110ms emulated, 6 MiB/s cap, provider fixture 6.6MB/600ms — these are substrate-specific, NOT portable production claims.*

- **cold-8** (8-pane cold load): wire **15.58MB → 0.277MB (−98.2%)**; TTI_last **3792 → 3202ms (−15.6%)**; provider network GETs 16→1; other enumerated /oc/* GETs 46→4; pane-doc stride 226ms → 0ms (eliminated)
- **warm-8**: wire **6.03MB → 0.284MB (−95.3%)**; TTI_last **3135 → 2871ms (−8.4%)**; enumerated-path network hits 0
- **X5 decomposition of remaining ~2.9s cold TTI**: app-waterfall RTT multiplication ~2.6–2.74s (OUT of program scope — named+sized future-program candidate), transport-added ≈0ms median (only fresh-stream ACK gate 168–198ms on first two SSE opens), fixed compute ≈346ms. Cold TTI is no longer wire-bound.

## Verification
| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| Final nine-lane suite green | `tmp/agent-runs/page-load-perf/final-suite/` receipts bound to `bdf51df` | yes |
| Lane 4 green on fix tree | `tmp/agent-runs/page-load-perf/final-suite/lane-4-fix/` bound to `e726b4e` | yes |
| Program slices green (raw) | `tmp/agent-runs/page-load-perf/raw/{s1,s2,s2b,s3b,x5}-*/` | yes |
| Slice reviews approved | `.local/coordinator/reports/page-load-perf-*/` (closeout + review per slice) | yes |

*Note: The raw and final-suite runs are gitignored paths.*

## Findings
- **(S4 daemon provider single-flight)**: source=S4, confidence=high, type=fact. Parked: no demonstrated latency payoff after SW coverage. Trigger: provider CPU/latency evidence on SWR-expired/non-SW clients.
- **(S5 lean StandaloneCode entry)**: source=S5, confidence=high, type=fact. Parked: needs parse/CPU profile first.
- **(S6 tunnel handshake fold/skip-ACK)**: source=S6, confidence=high, type=fact. Parked: X5 measured median TTI yield ≈0ms (worst run 111–143ms); not worth negotiated mixed-version cost. Revisit trigger: fresh-stream count per load (from /vh/diag ack_dur Δ) ≫ 10. If ever revived: negotiated/backward-compatible (VH_TUNNEL_DEFLATE precedent).
- **(S7 SharedWorker stream-sharing)**: source=S7, confidence=high, type=fact. REJECTED for Phase B. Revisit trigger: after S1–S3, warm-8 TTI_last >2.5s AND residual dominated by per-pane chains AND Android Chrome ≥152/WebView fleet coverage known.
- **(Residuals 4/5)**: source=S7, confidence=high, type=fact. per-pane tree streams + watch SSE remain functionally duplicated (8+8 live SSE) — parked under the S7-class stream-sharing trigger.
- **(App-waterfall RTT multiplication)**: source=X5, confidence=high, type=fact. ~2.6–2.74s of cold-8 is out of program scope; named, sized, parked as future-program candidate (app restructure).
- **(Lane-4 flow-1 flake)**: source=Lane-4, confidence=high, type=fact. tests/e2e-docker/run.sh:197–206 still assert pre-batch message.upsert/part.upsert while cold-boot now ships messages.batch (gzip64+window) — owner: stream-protocol owner; tripped 1/2 full runs.
- **(Production Dockerfile identical breakage)**: source=Lane-4, confidence=high, type=fact. hostbuild stage missing the same COPY → `make docker` deterministically broken since 5d24f3f. One-line mirror fix recommended. Trigger: path_touched(Dockerfile).
- **(CI grep guard)**: source=Lane-4, confidence=high, type=inference. advisory guard suggested since host-web→web/ cross-tree imports re-break the single-file COPY convention.
- **(Trigger-bound review defers riding in tree)**: source=Reviews, confidence=high, type=fact. lever-A boot-call wiring (index.tsx next touch); delayed-registration fail-open e2e (before any born-controlled-completeness claim); layout-persistence javascript: guard (guard when next touched); notificationclick device QA; d-F2 ack port leg; c-F3 registerPromise reset; mirror text-pin shell-bypass vocab (path_touched web/public/sw.js); lane-8/9 host-dispatch SW-stamp assertion (path_touched real-embed spec).
- **(C lazy-boot policy)**: source=S3b, confidence=high, type=fact. eager visible panes vs focus-only boot: byte-motivation RETIRED by S3b (wire near zero regardless); remains OPEN as a pure UX/product question for multi-visible desktop layouts.

## Contradictions
The `tmp/agent-runs/page-load-perf/final-suite/report.md` states lane 4 was RED on `bdf51df`. Lane-4 was RED at `bdf51df`; confirmed GREEN on fix tree `e726b4e` via `tmp/agent-runs/page-load-perf/final-suite/lane-4-fix/` receipts (standalone docker build green + full run.sh 9/9 flows PASS, run 2) and git reachability (e726b4e is an ancestor of HEAD). Contradiction resolved — the report.md BLOCKED verdict is the pre-fix state.

## Honesty Constraints
- All perf numbers substrate-specific (emulated RTT/BW/provider); not production WAN claims.
- UNVERIFIED at close: production (non-Playwright) Firefox top-level SW matching; real notificationclick gesture (mechanism proven via mirror pins + VH_PING/pong); window.focus() gesture-less per engine; production-nginx pooling fidelity.
- Known gap: lane-4 run-1 flake (above); r3 box-saturation outlier in S3b provider counts (1,1,5) disclosed.
