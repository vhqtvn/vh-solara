package web

// The end-to-end liveness sentinel probe (webperf slice 4 / F7 residual).
//
// PROBLEM (F7): liveness today is INFERRED. The 15s SSE `ping` is written by
// the per-connection handler's own ticker (pkg/web/server.go handleStream
// `case <-ticker.C`), so it proves only that the handler goroutine and the
// socket are alive — NOT that the worker's ingest pipeline (opencode /event →
// aggregator → state.Store emit fanout) still works. A worker whose pipeline
// is wedged keeps pinging forever while content silently stops: the idle
// watchdog skips (expected silence) and the content watchdog on an ACTIVE
// session forces a cursorless full snapshot even when the silence is a
// legitimate long tool run. Neither is a PROVEN fact.
//
// PROBE: POST /vh/stream/probe?nonce=<client-generated-random> asks the
// WORKER's project aggregator's store to emit a transient `vh.liveness` event
// carrying that nonce. Because SSE streams terminate at the worker (the
// controller is a raw byte-proxy — pkg/server/proxy.go hijack +
// runBidirectionalCopy), a client receiving its own nonce back on an OPEN
// /vh/stream has PROVEN the full worker store → subscribe channel → SSE
// handler → yamux tunnel → controller → browser path end-to-end.
//
// Wire contract (mirrors the ping/notice transient class exactly — see the
// exemption list in handleStream's live-tail loop):
//   - event name: `vh.liveness` (const kindLiveness below);
//   - payload: {"nonce":"<echoed verbatim>"};
//   - NO `id:` line — written via writeRawNoID, so it can NEVER advance the
//     client's Last-Event-ID resume cursor or the per-connection delivery
//     ordinal (the Inv1 gap-detection machinery ignores it exactly as it
//     ignores ping/notice);
//   - state.Store.EmitTransient semantics: NOT recorded in the replay ring
//     (a reconnecting client never replays it), does NOT advance the store
//     seq (resume cursors stay monotonic), and BYPASSES the per-subscriber
//     Interest filter (it reaches every live subscriber of the project
//     store, including message-filtered session streams and the tree-only
//     stream — Interest is a message-class flood filter, irrelevant here);
//   - no persistence, no snapshot inclusion: EmitTransient touches none of
//     the snapshot/gate state.
//
// Auth/CSRF: the route lives under the /vh/* mux, so the cross-cutting chain
// (securityHeaders → auth → cors → csrfGuard → …) applies. POST is an unsafe
// method, so csrfGuard requires the X-VH-CSRF header (the SPA's installCsrf
// adds it automatically) — no per-handler check needed, mirroring handleAck.
//
// Skew: an OLD worker has no route → the mux 404s → the SPA memos
// capability-unavailable and falls back to today's heuristics exactly
// (sentinel-legacy-fallback). A NEW worker behind an OLD controller is fine:
// the controller blind-proxies the POST and the SSE frame as raw bytes.
//
// Statelessness (SharedWorker migration note, brief §G3): the handler holds
// NO per-client state. The nonce is client-generated and correlated by the
// client; the emission is a fire-and-forget broadcast on the project store.
// A future SharedWorker owner rung inherits the endpoint unchanged.

import (
	"encoding/json"
	"net/http"
)

// kindLiveness is the SSE event name carried on the wire for the transient
// liveness fan-out frame. The direct analogue of kindPinsUpdated /
// kindLabelsUpdated / kindArchiveFailuresUpdated (pkg/web): a web-layer-owned
// transient kind fanned out via state.Store.EmitTransient, forwarded by the
// handleStream live-tail loop through writeRawNoID (no id line, no cursor
// advance). Deliberately NOT a pkg/state Kind constant: the store's
// classifiers (IsMessageClassKind / IsTreeCountedKind) must NOT list it — it
// is not ordinal-counted and not interest-filtered on any stream.
const kindLiveness = "vh.liveness"

// maxLivenessNonce bounds the echoed nonce so a hostile/buggy caller cannot
// make the broadcast payload arbitrarily large. 128 bytes is far above any
// reasonable client-generated token (UUID/hex).
const maxLivenessNonce = 128

// handleStreamProbe emits one transient vh.liveness event carrying the
// caller-supplied nonce into the request's project store, then replies OK.
// The event reaches every live /vh/stream subscriber of that project (both
// the tree stream and session streams — EmitTransient bypasses Interest);
// whichever stream the client is reading delivers the frame first is the
// proof. POST /vh/stream/probe?nonce=<string>[&dir=<project>].
func (s *Server) handleStreamProbe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nonce := r.URL.Query().Get("nonce")
	if nonce == "" || len(nonce) > maxLivenessNonce {
		http.Error(w, "nonce required (max 128 bytes)", http.StatusBadRequest)
		return
	}
	// aggFor (not aggForExisting): identical side-effect posture to GET
	// /vh/stream — the project the browser is streaming is open by
	// construction, and a probe must NEVER 404 for an unopened dir (404 is
	// the version-skew capability signal the client memos for its lifetime;
	// conflating it with "project not open" would disable the sentinel for
	// the whole session). Auth-gated + CSRF-gated like every /vh mutation.
	agg := s.aggFor(reqDir(r))
	payload, err := json.Marshal(map[string]string{"nonce": nonce})
	if err != nil {
		http.Error(w, "marshal failed", http.StatusInternalServerError)
		return
	}
	agg.Store().EmitTransient(kindLiveness, payload)
	writeJSONResp(w, map[string]any{"ok": true, "nonce": nonce, "kind": kindLiveness})
}
