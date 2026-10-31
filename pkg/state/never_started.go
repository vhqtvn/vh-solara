// Package state: the never-started turn classification (P1 of the
// 2026-10-31 instant-abort incident study; incident signature validated against
// the production opencode DB — see tmp/handoff-instant-abort-and-stale-ui.md
// and tmp/handoff-instant-abort-round2.md).
//
// WHAT HAPPENED: opencode can abort a turn 7–27 ms after the assistant row is
// created — before the processor ran, before any part (not even step-start),
// before the provider call. The ONLY upstream writer of that exact row shape
// is finalizeInterruptedAssistant (refs/opencode
// packages/opencode/src/session/prompt.ts:1203: a silent fiber interruption
// finalizes the pre-seeded row — error=MessageAbortedError with
// data.message="Aborted", tokens all zero, zero parts — stamped with
// time.completed). Until this file, the state layer classified EVERY
// MessageAbortedError as a POSITIVE terminal "operator/limit abort"
// (isTerminalError), and the web UI rendered the row as a plain red
// "⚠ Aborted" — indistinguishable from the user pressing Stop. The operator's
// reaction in the incident (re-send twice, then two restarts) shows exactly the
// confusion: nothing said "opencode refused to run this turn; not your fault;
// re-sending will likely do the same". A REAL operator abort in the same
// session was 145 s long with substantive parts — never in the
// ≤100 ms + zero-parts + zero-tokens shape (validated control). opencode's own
// replay logic (cli/cmd/run/session-data.ts) already treats
// MessageAbortedError rows as skippable; honoring the instant shape as a
// positive operator abort was a vh-solara POLICY choice, reversible.
//
// CLASSIFICATION (this file): a completed assistant row carrying
// error.name=MessageAbortedError whose time.completed − time.created ≤
// neverStartedMaxDurationMs, with zero parts and zero tokens, is REFINED into
// a distinct terminal outcome — NeverStartedErrorName ("turn never ran"). The
// refinement is applied at the SAME two body-adoption sites that cache
// terminalError (upsertMessageLocked live events; reconcileMessagesLocked
// history fetch), by rewriting ONLY the info.error block (upstream times,
// tokens and provenance survive; the upstream name is preserved as
// error.data.cause). Everything NOT matching the full signature — including
// every real operator/limit abort — keeps today's positive-terminal
// MessageAbortedError meaning. REVERSIBLE by construction, on two axes: the
// classification is re-derived from upstream truth at every adoption (a later
// fetch that DOES carry parts restores the raw upstream shape), AND the
// zero-parts conjunct is enforced across time — the raw pre-refinement body
// is retained on the entry (neverStartedRaw) and a FIRST part arriving later
// revokes the refinement immediately (upsertPartLocked), so a parts-bearing
// turn can never keep the never-started presentation.
//
// RELATION TO isTerminalError: NeverStartedErrorName IS a member (unlike
// VHSolaraInterruptedError, which is deliberately excluded). The asymmetry is
// provenance: the interrupted marker FABRICATES a terminal opencode never
// wrote (pure inference), while the never-started marker only REFINES a
// terminal opencode itself positively wrote (completed + error). Both the
// messages-loaded gate (latestAssistantResidentLocked) and the reconcile
// empty-newest admit (reconcileMessagesLocked) therefore fast-path a
// never-started newest exactly as they did when it wore the upstream name.
//
// THE ABORT-MARKER QUESTION (resolved during implementation, per the task
// brief): the ideal classifier would also know "vh-solara sent no /vh/abort
// for this session". No cheap, reliable, durable marker of that exists:
//   - /vh/abort (pkg/web/verbs.go) and abortInflightBeforeRestart
//     (pkg/web/opencode.go) call Client.Abort then Store.Stop, which sets only
//     TRANSIENT in-memory state (turnState=TurnStopping + stopTurnID) that
//     settles via the settle timer / status reconcile and is rebuilt from
//     scratch on hydrate — not a timestamped ledger a later classification can
//     consult;
//   - abortInflightBeforeRestart writes nothing to the store at all (logs only);
//   - the restart fence (pkg/web/restart_fence.go) stamps QUEUE dispatch
//     items (queue.json), a different entity, only at restart time.
//
// What IS wired: BOTH adoption surfaces suppress the refinement while the
// session is TurnStopping (classifyNeverStartedLocked) — the one window where
// "we just aborted this session" is observable in-memory under the lock we
// already hold. Suppress-only: a hit falls back to today's plain-abort
// presentation, never a wrong "not your abort" claim. Best-effort by
// ordering (the terminal SSE event can beat the Abort HTTP response that
// precedes Store.Stop, so the guard can miss our own abort): the residual
// exposure is bounded by the signature itself — a vh-solara-initiated abort
// only lands inside the ≤100 ms + zero-parts + zero-tokens shape if the turn
// was under 100 ms old when aborted, and every abort vh-solara issues (user
// Stop button, pre-restart sweep) targets turns that are seconds-to-minutes
// old, which the duration conjunct already excludes. No durable marker
// survives reconnect/daemon restart for historical rows, so the signature
// alone remains the carrier there (and everywhere outside the TurnStopping
// window).
package state

import "encoding/json"

// NeverStartedErrorName is the terminal-error name the state layer refines an
// upstream instant MessageAbortedError into. DELIBERATELY distinct from every
// upstream name and from InterruptedTurnErrorName: a reader can tell "this
// turn never ran (instant self-abort, refined by vh-solara from an upstream
// terminal)" from "operator/limit abort (upstream MessageAbortedError)" and
// from "vh-solara inferred an interruption (sweep)". Surfaced through
// info.error.name so the FE renders it through the existing messageError
// affordance, with error.data.cause preserving the upstream name.
const NeverStartedErrorName = "VHSolaraNeverStartedError"

// neverStartedUserMessage is info.error.data.message for the refined marker —
// the user-facing string the FE shows (messageError prefers data.message over
// name; the FE's neverStartedNotice passes it through). It must communicate
// the three facts the incident showed were missing: the turn never ran, it was
// NOT the operator's stop, and re-sending will likely repeat it.
const neverStartedUserMessage = "Turn never ran: OpenCode aborted this turn before it started — this was not your stop. Re-sending will likely repeat this."

// neverStartedMaxDurationMs is the completed−created ceiling (unix ms) for the
// never-started signature. Observed instances: 27 ms and 7 ms (a fresh row
// seed + finalizeInterruptedAssistant write). ~4× headroom over the observed
// max while staying three orders of magnitude below the fastest real operator
// abort observed (145 s control) and below any plausible human round-trip.
const neverStartedMaxDurationMs = 100.0

// neverStartedSignature reports whether env matches the validated
// incident signature of a turn that never ran: an ASSISTANT row, terminally
// errored with MessageAbortedError, completed within
// neverStartedMaxDurationMs of creation, with zero parts and zero tokens.
// partCount is the part count the calling surface can vouch for at
// classification time (live: resident parts; reconcile: fetched + resident).
// Anything failing a conjunct — notably a real operator/limit abort, which has
// run long enough to produce parts and (usually) duration ≫ 100 ms — returns
// false and keeps the upstream operator-abort classification.
func neverStartedSignature(env *messageInfoEnvelope, partCount int) bool {
	if env.Role != "assistant" || partCount != 0 {
		return false
	}
	if env.Error == nil || env.Error.Name != "MessageAbortedError" {
		return false
	}
	if env.Time.Created == nil || env.Time.Completed == nil {
		return false
	}
	if *env.Time.Completed-*env.Time.Created > neverStartedMaxDurationMs {
		return false
	}
	return tokensAllZero(env.Tokens)
}

// tokensAllZero reports whether a raw opencode tokens object carries no
// positive usage count. Absent/nil/empty/unparseable tokens count as zero
// (the confirmed incident rows carry all-zero counts; absence on a
// zero-parts ≤100 ms abort row is equivalent evidence). Any nested positive
// number (input/output/reasoning/cache.read/cache.write/...) disqualifies.
func tokensAllZero(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return true
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return true // absent-shaped or non-object: no positive count provable
	}
	return tokensMapAllZero(m)
}

func tokensMapAllZero(m map[string]any) bool {
	for _, v := range m {
		switch t := v.(type) {
		case map[string]any:
			if !tokensMapAllZero(t) {
				return false
			}
		case float64:
			if t > 0 {
				return false
			}
		}
	}
	return true
}

// classifyNeverStartedLocked is the under-lock gate BOTH adoption surfaces
// call before refining: the pure signature PLUS the abort-suppression guard.
// While the session is TurnStopping, a /vh/abort (or the pre-restart abort
// sweep) is actively settling for THIS session, so an instant
// MessageAbortedError terminal may be OUR abort landing — suppress the
// refinement and keep the honest upstream operator-abort classification
// (suppress-only: the fallback is today's behavior, never a wrong claim).
// Applied on the live path (upsertMessageLocked) AND on history reconcile
// (reconcileMessagesLocked): a fetch racing the TurnStopping window gets the
// same conservative treatment, and the guard is moot outside that window.
// Caller holds s.mu.
func (s *Store) classifyNeverStartedLocked(sid string, env *messageInfoEnvelope, partCount int) bool {
	if s.turnState[sid] == TurnStopping {
		return false
	}
	return neverStartedSignature(env, partCount)
}

// revokeNeverStartedOnFirstPartLocked enforces the zero-parts conjunct ACROSS
// time: when the caller is inserting the FIRST resident part of an entry
// carrying the never-started refinement, the run demonstrably started —
// restore the retained raw upstream body (neverStartedRaw), re-classify as
// the upstream error name, clear the retention, and (emitRestored) emit the
// restored body so live clients drop the "turn never ran" presentation.
// Called from ALL THREE part-ingestion paths: the authoritative part.upsert
// (upsertPartLocked), the streaming part.delta placeholder insert
// (appendPartDeltaLocked — a delta can precede its part.updated;
// commit-review R2-F1), and the history-fetch merge loop
// (reconcileMessagesLocked — where coldLoad && liveTouchedBody can skip body
// adoption on a still-refined entry; commit-review R3 B-F1/C-F1; that caller
// passes emitRestored=false on coldLoad because the wholesale cold batch
// carries the restored body). A genuine never-started turn emits NO parts
// and NO deltas (no provider call), so any first part on a refined entry is
// itself proof the run started. Caller holds s.mu.
func (s *Store) revokeNeverStartedOnFirstPartLocked(me *messageEntry, emitRestored bool) {
	if me.terminalError != NeverStartedErrorName || len(me.neverStartedRaw) == 0 {
		return
	}
	raw := me.neverStartedRaw
	me.info = raw
	me.terminalError = ""
	me.neverStartedRaw = nil
	var rawEnv messageInfoEnvelope
	if json.Unmarshal(raw, &rawEnv) == nil {
		me.terminalError = rawEnv.errorName()
	}
	if emitRestored {
		s.emit(KindMessageUpsert, me.info)
	}
}

// mergeNeverStartedInfo rewrites ONLY the error block of a message info body
// into the never-started marker: name=NeverStartedErrorName,
// data.message=neverStartedUserMessage, data.cause=<the upstream error name
// preserved for provenance>. Non-error fields pass through as
// json.RawMessage — no float64 re-encoding, so numeric lexemes (>2^53
// integers, high-precision decimals) survive with their exact digits
// (commit-review B-F3/D-F3); json.Marshal's RawMessage compaction may still
// normalize insignificant whitespace in those values, which no opencode
// payload depends on. Unlike mergeInterruptedMarkerInfo this never stamps
// time.completed (the upstream row already carries it). Byte-stable for a
// fixed base: map marshaling sorts keys, and the inputs are derived only
// from the base, so a warm re-fetch of the same raw row re-merges to
// identical bytes (no spurious diff-emits on repeated reconciles). Returns
// nil on an unparseable base; the caller keeps the original bytes (the
// cached terminalError still carries the classification).
func mergeNeverStartedInfo(base []byte) []byte {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(base, &m); err != nil || m == nil {
		return nil
	}
	cause := ""
	if existing, ok := m["error"]; ok {
		var env messageErrorEnvelope
		if json.Unmarshal(existing, &env) == nil {
			cause = env.Name
		}
	}
	data := map[string]any{"message": neverStartedUserMessage}
	if cause != "" {
		data["cause"] = cause
	}
	errBlock, err := json.Marshal(map[string]any{
		"name": NeverStartedErrorName,
		"data": data,
	})
	if err != nil {
		return nil
	}
	m["error"] = errBlock
	out, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return out
}
