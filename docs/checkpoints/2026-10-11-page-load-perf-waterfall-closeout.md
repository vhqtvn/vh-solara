# Page Load Perf Waterfall Arc Closeout

## Arc shape
The page-load waterfall optimization arc in vh-solara is COMPLETE. All slices investigated, debated, implemented, and verified locally.
- **P0 diagnostic**: per-URL wire-send lock-step diagnosis. Proved pane-DOCUMENT fetches were simultaneous all along; the cross-pane stair was per-pane `/vh/highlight.css` (227ms/pane median = one app RTT); browser-internal per-URL wire-send lock-step across iframes; candidate mechanisms a/b/c refuted.
- **Solution brief & debate**: `need_evidence` verdict on delivery mechanisms.
- **tmp-only spike**: B-bundle selected. Measured exact CSS output is 10,993 B (`render.New().HighlightCSS()`, sha256 `ab0069e2...b50c12`); byte-parity and unlayered cascade order proven; brief's initial ~4.1KB estimate corrected.
- **B-bundle (`8a0303cf`)**: 5 files. Committed generated artifact (`web/src/styles/highlight.generated.css`) + first-import wiring (`web/src/index.tsx`) + `<link>` removal (`web/index.html`) + Go byte-parity gate (`pkg/web/highlight_parity_test.go`) + unit pins (`web/tests/unit/highlight-bundle.test.ts`).
- **P2 (`e954114`)**: SPA entry preload hints via host-web vite plugin (`spaEntryPreload()`). Reads staged `web/dist-build/index.html` and mirrors modulepreload/preload tags into host shell; mechanism verified, TTI delta immaterial (−3ms); kept as zero-cost plumbing (S2b strictly-better precedent).
- **P1-fork debate**: P1 PARKED. Plan premise stale — SPA boots via two EventSources, not `GET /vh/snapshot`; coordinator premise-check: server-side single-flight measured pointless because upstream hydration is already in-flight-deduped.
- **P2b (`b460ca70`)**: SW activate-time precache REFUTED. Precache mechanism proven, but caused a +145ms cold-8 TTI regression — activate-held fetch delayed `paneSrcGate` ~420ms, while saved wire was hidden under provider wait; precache reverted to HEAD. Landed staging guard only (folded builds fail loudly on missing or unparseable `web/dist-build/index.html`) + Dockerfile and Dockerfile.e2e hostbuild COPY fix closing the hint-less-shell gap present since e954114.

## Headline numbers
*All numbers MEASURED on the perf harness substrate — RTT 110+110ms emulated, 6 MiB/s cap, provider fixture 6.6MB/600ms; n=3 medians; raw receipts at `tmp/agent-runs/page-load-perf/raw/{p0,bbundle,p2,p2b}-after-*/` — these are substrate-specific, NOT portable WAN claims.*

- **B-bundle (`8a0303cf`)**:
  - cold-8 TTI_last: **3161 → 1890ms (−1271ms, inside [E] −1.2..−1.4s)**
  - `/vh/highlight.css` GETs: **8 → 0** (CDP + worker-edge)
  - cross-pane stair: **1329ms monotone spread → 104–211ms non-monotone jitter** (eliminated)
  - cold wire: **−88.4KB**
  - warm-8 TTI_last: **2871 → 1515ms (−1356ms)**; warm wire: **−86.5KB**; enumerated hits: **0**
- **P2 (`e954114`)**:
  - cold-8 TTI_last: **1890 → 1887ms (−3ms, immaterial / within spread)**
  - warm-8 TTI_last: **1515 → 1441ms (−74ms, within spread)**
  - landed as zero-cost plumbing (strictly-better-or-neutral; S2b precedent). P2's preload hints add ~344KB of cold entry-asset wire (spa_asset 0B→~344KB; host-document fetch path re-fetching hinted entries the SW then re-serves), warm unaffected.
- **P2b (`b460ca70`)**:
  - cold-8 TTI_last: **1887 → 2032ms (+145ms regression)** → activate precache reverted to HEAD; build guard and docker staging COPY landed.
- **Program totals vs Phase-A baseline**:
  - **cold-8**: wire **15.58MB → ~549KB (−96.5%)**; TTI_last **3792 → 1887ms (−50.2%)**
  - **warm-8**: wire **6.03MB → ~205KB (−96.6%)**; TTI_last **3135 → 1441ms (−54.0%)**
  - *(Note: B-bundle stage briefly touched ~198KB cold wire before P2's preload hints re-exposed ~344KB of entry-asset wire.)*

## Verification
| Claim | Verifying command/output | Verified |
|-------|--------------------------|----------|
| B-bundle highlight CSS bundled in app stylesheet | Commit `8a0303cf`; `go test ./pkg/web/ -run TestHighlightParityGeneratedCSSArtifact`; `web/tests/unit/highlight-bundle.test.ts` | yes |
| B-bundle cold-8 TTI_last 3161→1890ms (−1271ms), GETs 8→0 | Receipts `tmp/agent-runs/page-load-perf/raw/bbundle-after-cold-8/` bound to `8a0303cf` | yes |
| B-bundle warm-8 TTI_last 2871→1515ms, wire −86.5KB | Receipts `tmp/agent-runs/page-load-perf/raw/bbundle-after-warm-8/` bound to `8a0303cf` | yes |
| P2 SPA entry preload hints in host shell | Commit `e954114`; lane-9 pin in `host-web/tests/folded-e2e/folded-restore.spec.ts`; receipts `tmp/agent-runs/page-load-perf/raw/p2-after-cold-8/` | yes |
| P2b precache regression (+145ms) reverted; staging guard landed | Commit `b460ca70`; 5-leg guard RED proof `tmp/agent-runs/page-load-perf/receipts/p2b-guard-red-proof.log`; docker e2e exit 0 | yes |
| Cumulative program totals (cold −50% TTI, wire −96.5%) | Synthesis of arc-1 receipts (`tmp/agent-runs/page-load-perf/final-suite/`) + waterfall receipts (`tmp/agent-runs/page-load-perf/raw/p2-after-{cold,warm}-8/`) | yes |

## Findings
- **(P0 lock-step stair root cause)**: source=P0 diagnostic, confidence=high, type=fact. Pane document fetches were simultaneous all along; stair was per-pane `/vh/highlight.css` (227ms/pane median = 1 app RTT) serializing via browser-internal per-URL wire-send lock-step.
- **(B-bundle cascade and size)**: source=B-bundle spike, confidence=high, type=fact. Highlight CSS is 10,993 B exact `render.New().HighlightCSS()` (sha256 `ab0069e2...b50c12`); brief's ~4.1KB estimate was incorrect. First-import order ensures highlight classes precede app rules without CSS layers.
- **(P2 preload hints latency impact)**: source=P2 harness, confidence=high, type=fact. SPA entry asset acquisition leg is ~450ms SW-coalesced; cold-8 TTI is gated by vh-API / 2-connection contention tail, so preload hints yield immaterial delta (−3ms) on this substrate.
- **(P2b SW activate-time precache regression)**: source=P2b harness, confidence=high, type=fact. Precache mechanism worked but delayed `paneSrcGate` ~420ms while activate was held; saved network wire was masked by provider wait, causing net +145ms cold TTI regression.
- **(Stale P1 plan premise)**: source=P1 debate / coordinator premise-check, confidence=high, type=fact. SPA boots via two EventSources, not `GET /vh/snapshot`; upstream hydration is already in-flight-deduped; server-side single-flight was measured pointless.

## Contradictions
- **P2 asset-leg thesis refuted by measurement**: P2's hypothesis that accelerating the ~450ms SPA entry asset acquisition would shave cold-8 TTI was refuted. TTI on this substrate is provider-bound and gated by vh-API / 2-connection contention; preload hints produced an immaterial delta (−3ms).
- **P2b precache regressed despite mechanism proof**: Activate-time entry asset precache demonstrated working fetch parallelism, but holding SW activation delayed `paneSrcGate` ~420ms. The network wire saved was hidden under provider wait, yielding a net +145ms regression.
- **P1 plan premise stale**: The proposed P1 server-side single-flight assumed the SPA boot sequence blocked on `GET /vh/snapshot`. The SPA actually boots via two live EventSources, and upstream hydration is already in-flight-deduped, making server-side single-flight redundant.
- **Brief highlight CSS size estimate wrong**: The initial solution brief estimated highlight CSS at ~4.1KB. The measured handler output from `render.New().HighlightCSS()` is 10,993 B exact.

## Parked-with-trigger ledger
- **P1 (server-side stream/snapshot single-flight)**: Parked. Trigger: `eight-pane request trace showing material duplicate work + continuity prototype >= 200ms`.
- **S6 tunnel handshake fold / skip-ACK**: Parked. Measured fresh-stream count per load (from `/vh/diag` `ack_dur` Δ) is 8–9, not meeting threshold. Trigger: `fresh-streams >> 10 via /vh/diag ack_dur delta`.
- **S7 SharedWorker stream-sharing**: Parked. Trigger: `Android >= 152 / WebView fleet data + post-P1`.
- **P3 / P4**: De-prioritized and parked; residual gains diminishing after B-bundle.
- **Guard CI test**: Parked. Trigger: `upgrades to BLOCK on next host-web/vite.config.ts touch without test`.
- **sw.js empty-open hardening**: Parked (optional, benign finding).
- **Warm-cache never-reuse mystery**: Parked with reopen trigger from the highlight-css debate.
- **G6 containment re-check**: Parked. Trigger: `path_touched(web/package.json | host-web/vite.config.ts)`.
- **G7 pin-regex**: Parked. Trigger: `path_touched(web/src/index.tsx)`.

## Honesty Constraints
- All perf numbers substrate-specific (emulated RTT 110+110ms, 6 MiB/s, provider fixture 6.6MB/600ms); NOT portable WAN claims.
- Measured floor is provider+chain-bound (X5: LAN TTI ~410ms ⇒ ~2.9s of remote cold TTI is RTT-chain — explicitly pre-B-bundle evidence predating the arc, which final cold TTI 1887ms cannot describe unchanged; X5 transport-removable ≈0ms; quantifying the current provider+chain floor would need a fresh post-waterfall LAN/remote decomposition [not run; parked]).
- All estimates labeled [E].
