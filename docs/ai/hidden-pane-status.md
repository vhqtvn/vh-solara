# Hidden-pane status: semantics, ownership, and freshness boundary

**Status:** current (2026-10-04, Phase-1 "A" fix) · **Owner:** web SPA sync (`web/src/sync.ts`,
`web/src/sync/`) + host consumption (`host-web/src/dockview/store.ts`) · **Contract surface:**
`vh-host-visibility` (`host-web/src/dockview/types.ts`), `statusEmitter` posts (`web/src/statusEmitter.ts`)

## What this governs

An operator watching the host shell must see **live running/unread counts on the tab badges of
workspaces they are not currently looking at**. Each workspace's badge (`ws-tab-pairs`,
`ws-needs-you`) is fed by the *panes inside that workspace* posting status to the host — including
panes whose iframe the host has hidden with `visibility: hidden` (inactive workspace; dockview
`renderer: "always"` keeps every iframe mounted).

Until 2026-10-04 the SPA suspended **both** SSE streams when the host hid it (commit 266eff9's
idle-heat fix), so `statusEmitter` — which derives counts from the tree store — froze with them.
The host-side consumption layer was sound; the freeze was purely production-side. Lane 8
(`host-web/tests/real-embed-e2e/real-embed.spec.ts`, "hidden-pane status liveness") is the
end-to-end repro/proof: real local-server binary + real SPA + real fixture drive, badge polled on
the real path.

## Semantics after the A fix

Two hiders are distinguished (`web/src/paneVisibility.ts`):

- `paneVisible() = docVisible() && hostVisible()` — the operator can see this pane.
- `isDocVisible()` — the document is foregrounded, *even if* the host has hidden the pane.

| State | Tree stream (Stream-1) | Transcript stream (Stream-2) | Watchdog / recovery | resyncTree (drift self-heal) |
|---|---|---|---|---|
| visible | live | live (follows selection) | full (both branches) | runs |
| **host-hidden** (doc visible) | **live — badges must stay fresh** | suspended (cursor preserved) | **tree branch keeps running** (incl. liveness-probe timeout path); session branch stands down | stands down (reveal owns the authoritative reconnect) |
| doc-hidden (standalone backgrounded) | suspended | suspended | stands down entirely | stands down |

Boot: a host-hidden pane with a project still opens its tree (`startSync` boot branch); only a
doc-hidden boot defers all streaming to the reveal.

Why the tree and not just a poll: the counts must reflect *events* (session busy/idle transitions,
unread watermarks) with ~1 s fidelity, and the SPA already has the derivation (`derivePaneCounts`)
and the 1 Hz posts-only-on-change emitter (`statusEmitter`, NOT visibility-gated — pinned by unit
test). Keeping the tree SSE alive is the cheapest way to keep that derivation fed; a dedicated
status poll would be a second, competing source of truth.

## Attention / unread parity (what background observation must NOT do)

- The emitter's `attention` (needs_permission > needs_reply) is reported for the **selected session
  only**; a hidden pane never auto-selects.
- **Unread is never acked by background observation.** Acking happens through the pane's own
  selected-session surface; a hidden pane observing `unread.set` on its live tree keeps the
  watermark (lane 8 asserts a 3 s hidden soak does not clear `(0|1)`).
- The heartbeat/document-liveness protocol is orthogonal and unchanged: **"document alive" ≠
  "status fresh"** (host-web/docs/heartbeat-protocol.md). A pane can be alive with frozen status (doc-hidden)
  and, now, fresh-status while invisible (host-hidden).

## Failure and reconnect behavior while host-hidden

- A closed or dead-but-open **tree** socket is recovered by the watchdog's tree branch while
  host-hidden (a frozen badge must not persist just because the socket died while nobody looked).
  The liveness-probe timeout path also recovers while host-hidden.
- **Detected** tree drift heals even while hidden: delivery-ordinal gaps (`tree-seq-gap` in
  `tree-transport.ts`) force `connect(true)` unconditionally.
- **Undetected** drift (missed non-ordinal content) heals at the reveal: `resyncTree` stays
  pane-gated on purpose — hidden badges need event delivery, not snapshot parity, and periodic
  cursorless snapshots per hidden pane are exactly the idle churn the webperf slices removed.
- **Reveal** is unchanged: the session stream resumes cursor-preserving (or opens the current
  selection fresh if it moved while hidden); the tree resume is a no-op when it was never suspended
  (the host-hidden case), so there is exactly one reconnection edge per real suspension.

### Known edge

An embedded pane that is host-hidden *when the document then goes hidden* fires no
`paneVisibility` transition (it was already false), so its tree stream stays connected while the
whole browser window is backgrounded. The browser suspends delivery as it sees fit; the doc-gated
watchdog stands down while hidden and recovers a dead tree when the document returns. Cost: one
open SSE per host-hidden pane for the duration of the backgrounded window. Accepted as-is for the
minimal fix; revisit only if it shows up in practice.

## Compatibility

- **Standalone (non-embedded) panes** are untouched: `hostVisible` is always true there, so
  `paneVisible ≡ docVisible` and both streams close on tab background exactly as before.
- **Old hosts** that never send `vh-host-visibility`: `hostVisible` defaults true — same standalone
  semantics.
- **Host-side** (B2: the host's own frozen `pairsByWs`/`needsYouByWs` for hidden workspaces) is a
  SEPARATE, deliberately-not-done slice; the lane-7 mock spec (`host-web/tests/e2e/overflow-live.spec.ts`)
  pins the host consumption behavior that the production path now actually feeds.

## How to measure (the paired procedure + 2026-10-04 headline results)

Procedure: fresh server pair per cell (the per-dir aggregator store hydrates asynchronously — a
pane connecting during that window races an empty snapshot and measures garbage; hard-gate setup
on a visible busy→running round-trip before hiding), N same-dir panes in one hidden workspace,
latency = POST `/oc/fixture/busy` → badge-flip poll at 50 ms, 30 s idle + 30 s 2 events/s burst
(busy/reset churn across all seeded sessions) with `/proc` (browser + server CPU/RSS) and
`ss -tin` (per-socket bytes) sampling every 2 s. Headless runs cannot ground Firefox/WebRender
claims — a headed capture would be needed for the GPU-cost side.

Headline numbers (chromium headless, baseline-vs-A at 2 and 4 panes, identical workloads):

- **Badge latency, upstream change → hidden-workspace badge: A ≈ 90 ms median, ≤ ~1.05 s p90,
  0 failed cycles in 20; baseline (pre-fix): never — 20/20 × 8 s timeouts.** Most cycles flip in
  81–98 ms (the 1 Hz statusEmitter poll dominates); the ~1 s tail is a cycle straddling a poll
  tick + emitter post.
- **No measurable compute delta at 2–4 panes:** browser CPU ≈ 68–101 % of one core and browser
  RSS ≈ 682–712 MB in EVERY cell (dominated by costs identical in both variants — the vite-dev
  host page, the mock fleet, heartbeat emitters); local-server CPU ≈ 0.1 % idle / ≤ 0.5 % burst
  in both.
- **The real new cost is hidden-tree event-fanout traffic: ≈ 108 KB / 30 s (≈ 29 kbit/s) at
  2 events/s** across all hidden panes, scaling with event rate (not measurably with pane count
  at 2→4). Caveats recorded at the time: `ss` byte fields aggregate per-socket lifetimes and are
  noisy against keep-alive pools; ESTAB counts are polluted by heartbeat keep-alives.
- 12-pane and headed (WebRender) cells were not run (time-boxed; 2→4 panes showed no movement).

Raw per-cell JSON (`measure-{A,baseline}-{2,4}p.json`) and the full table live in the measurement
session's run dir (`tmp/agent-runs/hidden-pane-status-20261004/`, gitignored — not part of the
tree); the driver spec was ephemeral and deleted after the session.
