# Document-liveness heartbeat protocol (host ⇄ embedded SPA)

Status: **Active.** Implemented by the host shell (`host-web/`) and the production
vh-solara SPA (`web/`). The mock content page (`host-web/iframe-content/`) is the
faithful stand-in used by the e2e gates.

This is a **contract-first** spec: it was written and reviewed against the seven
protocol constraints, the Q1-C semantic, and the Q2-A origin policy BEFORE any
implementation. Implementation reconciles with this document; it does not
re-litigate it.

---

## 1. Purpose & scope

The protocol makes **on-screen document/SPA liveness** observable: when a real
vh-solara SPA is embedded in a host pane (a cross-origin `<iframe>`), it tells the
host "this document is alive and is the same document I mounted." The host drives
a per-pane indicator from that signal.

**This protocol is NOT realtime/SSE/WS health.** A heartbeat fires regardless of
whether the SPA's SSE/WS streams are connected. The indicator MUST NOT be read as
"connected," "realtime healthy," "SSE healthy," or "receiving data." SSE-health is
a separate, future concern (out of scope here).

**Indicator states (Q1-C — exact label strings, §6).**

| State            | Meaning                                                              |
|------------------|----------------------------------------------------------------------|
| document alive   | heartbeat fresh; document identity (mountTs+nonce) stable; uptime climbing |
| reloaded         | document identity changed since the previously-observed identity     |
| no recent signal | heartbeat stale (older than the threshold) or never received         |

---

## 2. Threat model & what the protocol defends against

- **A spoofed / cross-talk heartbeat being attributed to the wrong pane.** Defended
  by per-pane binding: `event.source === iframe.contentWindow` AND `event.origin`
  matches the pane's configured server origin (constraint #3). Origin-only is
  insufficient; the source window must be the bound pane's own content window.
- **A stale heartbeat from a previous (pre-reload) document being attributed to the
  current document.** Defended by the per-mount identity + nonce freshness
  (constraint #4, §4): after a load, a pane re-establishes its identity; a
  heartbeat carrying a nonce that is neither the established identity nor the
  freshly-expected post-load identity is rejected as stale.
- **The SPA leaking its heartbeat to an arbitrary parent.** Defended by the
  embed gate (constraint #1) + origin capture (Q2-A, §3): the SPA replies only to
  the host origin it captured from the inbound handshake, never to a literal
  `"*"` and never when not embedded.

The payload carries **no secrets** (no tokens, cookies, routes, terminal, or SSE
state). It is the same threat class as the existing non-secret theme-token
postMessage (`web/src/themeTokens.ts`).

---

## 3. Messages & origin binding

All messages are JSON objects discriminated by `type`. There are exactly two
message kinds: a host→SPA **handshake** and an SPA→host **heartbeat**.

### 3.1 Host → SPA: handshake

```jsonc
{ "type": "vh-host-handshake", "nonce": "<string>" }
```

- `nonce` — a fresh random challenge string, generated per iframe document load
  (initial load + every reload). The SPA echoes this value back in its
  heartbeats so the host can bind a heartbeat to a specific document load.
- **Targeting (host side):** posted to `iframe.contentWindow` with `targetOrigin`
  set to the pane's configured server origin (derived from the pane's full
  `params.url` via `new URL(url).origin`). Never `"*"` (the host always knows the
  child origin — it is the pane's configured url).
- **When sent:** on the iframe `load` event (fires for the initial load and every
  subsequent reload). The host sends exactly one handshake per load.

### 3.2 SPA → Host: heartbeat

```jsonc
{ "type": "heartbeat", "mountTs": <number>, "nonce": "<string>", "uptime": <number> }
```

- `mountTs` — the SPA document's mount timestamp. Captured ONCE per document load
  (`performance.timeOrigin`, or a `Date.now()` at first embed-mode execution) and
  NEVER reassigned. Changes iff the document was destroyed and recreated (a
  reload).
- `nonce` — the document's identity challenge. BOTH the real SPA and the mock
  content page stand-in capture the `nonce` from the host handshake and echo it
  back, so the host knows the expected value before accepting a heartbeat (see
  §4). It is stable for the life of one document load and changes on reload (a
  reload is a new document that receives a fresh handshake with a fresh nonce).
- `uptime` — monotonic milliseconds since `mountTs` (`Date.now() - mountTs`),
  used to prove the document is progressing (uptime climbing ⇒ alive).

`connId` is **OPTIONAL** and kept only for the mock content page's WebSocket
negative control (see §7). The real SPA omits it. The host's liveness indicator
keys on `mountTs` + `nonce` + `uptime`, **never** on `connId`.

- **Targeting (SPA side, Q2-A):** the SPA replies with `targetOrigin` = the host
  origin **captured from the inbound handshake `MessageEvent.origin`** (browser-
  validated). Never a literal `"*"` and never a self-announced/configured string.
  No build-time config surface exists for this (the SPA is built-once-embedded-
  universally). If real origin-restriction is ever needed, it belongs in runtime
  `--frame-ancestors`, not in this protocol.

### 3.3 Embed gate (constraint #1)

The SPA emits **nothing** when `window.parent === window` (the standalone
case — the single-server SPA loaded directly). All heartbeat logic is a no-op
in standalone mode.

---

## 4. Reload / nonce lifecycle (constraint #4)

The host must (a) accept heartbeats from the currently-bound document, (b) reject
stale heartbeats from a previous document, and (c) detect a reload as an identity
change. The lifecycle is driven by the iframe `load` event + a per-pane
`pendingLoad` flag:

1. **On iframe `load`** (initial + every reload): the host sets
   `pendingLoad[paneId] = true` and sends a fresh handshake (§3.1), remembering
   the issued nonce as `expectedNonce[paneId]`. A reload produces a new load
   event ⇒ a new handshake + a new expected identity.
2. **On a heartbeat** that passes the source+origin binding (§5):
   - If `pendingLoad[paneId]` is set: the heartbeat must **echo the issued
     challenge** (`heartbeat.nonce === expectedNonce[paneId]`). A foreign nonce
     is **REJECTED as stale** — identity is NOT established and `pendingLoad`
     stays set (treated like a wrong-origin/wrong-window rejection). When the
     nonce matches (or no challenge was issued — the DEV scratch surface only),
     **ACCEPT** as the first heartbeat after a load — this establishes the
     pane's identity for this document. Clear `pendingLoad`. If a previous
     identity existed AND (`mountTs` or `nonce`) differs from it, mark the pane
     **reloaded** (record `reloadDetectedAt`).
   - Else if `heartbeat.nonce === establishedIdentity[paneId].nonce`: **ACCEPT**
     as a stable heartbeat (same document). Update `uptime` + `lastSeen`.
   - Else: **REJECT** as a **stale nonce** — an identity arrived without a
     preceding load, i.e. a heartbeat from a previous document or a spoof. This
     is the "stale-nonce rejection" path (constraint #4).

`establishedIdentity[paneId]` is the identity (`mountTs`, `nonce`) of the most
recently accepted heartbeat. `expectedNonce[paneId]` is the challenge the host
issued for the current pending load (stored in `sendHandshake`). A reload is
detected by comparing a newly-accepted post-load heartbeat's identity to the
previous one. Both the real SPA and the mock echo the handshake challenge, so the
host verifies the first post-load heartbeat against the value it issued before
establishing identity.

**Special case — the `naiveReload` negative control:** it creates a fresh iframe
outside the renderer (bypassing the renderer's `load` listener), so the host sets
`pendingLoad[paneId] = true` and re-sends the handshake explicitly inside that
hook. This keeps the survival gate's reload detection working under the new
protocol. `jsonReswap` disposes + recreates panels via the renderer, so load
events fire naturally and need no special handling.

---

## 5. Host-side acceptance rules (constraint #3 + #4)

For an inbound `message` event carrying `data.type === "heartbeat"`:

1. **Source window:** look up `paneId = sourceMap.get(event.source)`. Unknown ⇒
   **reject (wrong window)** — the message is not from any bound pane iframe
   (`event.source !== iframe.contentWindow` for every pane). This is constraint #3.
2. **Origin match:** compare `event.origin` to the pane's configured origin
   (`configuredOrigin[paneId]`, bound from `params.url`). Mismatch ⇒ **reject
   (wrong origin)** — constraint #3 (origin-only is insufficient; BOTH source and
   origin must match).
3. **Nonce freshness:** per §4 — accept on `pendingLoad`, accept on stable nonce,
   reject as stale otherwise.

Only heartbeats that pass all three update the pane's liveness state. Rejected
heartbeats have no effect on the indicator.

`title` and `route` messages (the pre-existing pane→host labels) are unaffected
and remain accepted on source-binding alone (they carry no liveness semantics).

---

## 6. Timeout semantics & exact UI labels (constraints #6 + #7)

- **Heartbeat cadence:** the SPA emits at ~4 Hz (250 ms interval, matching the
  mock stand-in). The host does not require an exact rate; it only evaluates
  freshness against a threshold.
- **"no recent signal" threshold:** a heartbeat whose `lastSeen` is older than
  **3 seconds** (≈ 12 missed beats at 4 Hz) transitions the pane to **no recent
  signal**. A pane that has never heartbeated is also **no recent signal**. A
  missed heartbeat is **never** diagnosed as an SSE/stream failure (constraint #7).
- **"reloaded" display window:** the **reloaded** state is shown for **4 seconds**
  after a reload is detected, then the pane returns to **document alive** (the new
  identity is now the established one). This makes an unexpected reload noticeable
  without permanently labeling a healthy pane.

A monotonic clock tick (≈ 2 Hz) re-evaluates each pane's state so staleness and
the reloaded-window expire reactively.

### Exact label strings (Q1-C — do not paraphrase)

| State            | Visible label           | Statusbar dot |
|------------------|-------------------------|---------------|
| document alive   | `document alive`        | on            |
| reloaded         | `reloaded`              | warn          |
| no recent signal | `no recent signal`      | off           |

The statusbar shows the **focused** pane's state. Each pane header carries its own
per-pane indicator (dot + the same label strings). The indicator is NEVER labeled
`connected`, `connecting`, `realtime healthy`, `SSE healthy`, `receiving data`,
or any realtime/stream-health wording.

---

## 7. Mock content page reconciliation (`connId` optional)

The mock content page (`host-web/iframe-content/content.ts`) is the **embedded-SPA
stand-in** for the e2e gates. Its existing heartbeat behavior is preserved to keep
the load-bearing survival gate (`tests/e2e/survival.spec.ts`, Chromium+Firefox,
50/50 incl. negative controls) green and non-vacuous:

- It **echoes the host's handshake challenge nonce** (constraint #4): it
  captures the `nonce` from the inbound handshake and echoes it in every
  heartbeat, so the host verifies the first post-load heartbeat against the
  value it issued — the same path the real SPA uses. Its ~4 Hz heartbeat holds
  off until the handshake arrives (no echoable nonce before then), matching the
  real SPA (`web/src/heartbeat.ts`).
- It keeps its **optional `connId`** (WebSocket echo connection id, the server-side
  reload signal the survival gate asserts on for negative controls). `connId` is
  **OPTIONAL** in the heartbeat schema; the real SPA omits it; the indicator keys
  on `mountTs`+`nonce`+`uptime`, never on `connId`.
- It keeps its `src` field (used by the gate). The real SPA omits `src`.
- It listens for the handshake to capture BOTH the host origin (Q2-A, for
  targeted non-secret replies) AND the challenge nonce (constraint #4, echoed in
  heartbeats). One handshake per load ⇒ the nonce is stable for the document's
  life and changes on reload (new document ⇒ new handshake ⇒ new nonce).

This keeps the survival gate's assertions (`mountTs`/`nonce`/`connId` unchanged ⇒
survived; changed ⇒ reloaded) exactly as they are.

---

## 8. Review against the seven constraints + Q1-C + Q2-A

- **#1 embed gate** — §3.3: SPA no-op when `window.parent === window`. ✓
- **#2 handshake, never `'*'`** — §3.1: host targets the child origin; §3.2/Q2-A:
  SPA replies to the captured handshake origin. ✓
- **#3 per-pane binding (source + origin)** — §5 steps 1–2: reject unknown source
  (wrong window) AND origin mismatch (wrong origin). ✓
- **#4 fresh nonce per mount/reload; stale rejected** — §4: `pendingLoad` +
  expected challenge (stored on handshake) + established identity; a foreign
  nonce while `pendingLoad` is true is rejected, and a stale nonce without a
  load is rejected (§5 step 3). ✓
- **#5 minimal payload** — §3.2: `{type, mountTs, nonce, uptime}`; `connId`
  optional (§7), no tokens/cookies/routes/SSE-state. ✓
- **#6 Q1-C labels** — §6 exact strings; never realtime wording. ✓
- **#7 missed = "no recent signal", not SSE-failure** — §6 timeout semantics. ✓
- **Q1-C (document liveness, not realtime)** — §1 + §6. ✓
- **Q2-A (captured origin, no build-time config)** — §3.2. ✓

No contradiction with the settled design was found during contract authoring.
