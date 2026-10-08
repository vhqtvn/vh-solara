package web

// Daemon-owned dispatch attempt executor — the attempt-journal WRITER
// (send-net-resilience slice 2a). Behind the capability gate: daemon
// dispatch ships OFF (daemonDispatchCapable == false, no production caller);
// this file is the testable unit the later drain loop will drive when the
// flag flips. It NEVER runs as part of the legacy browser dispatch path.
//
// JOURNAL PROTOCOL (one dispatch attempt = three durable writes around one
// upstream POST; every write passes the custody compare-and-fence gate):
//
//	1. ClaimForCustody   pending → dispatching   ("prepared": the OpenCode
//	                                           correlation id is minted and
//	                                           persisted in the same atomic
//	                                           save — claim-mint, unchanged
//	                                           from the legacy Claim)
//	2. BeginDispatchAttempt   append open QueueAttempt (generation,
//	                           StartedAt) = the `prepared → sending`
//	                           write-ahead record — BEFORE the POST
//	3. RecordAttemptOutcome   the transport-class receipt
//	                           (connect_failed | written_unknown |
//	                           server_error | accepted_2xx) — AFTER the POST
//
// Crash semantics (what the journal proves on reload): the journal state is
// EXACTLY what was last durably written. A crash between 2 and 3 leaves an
// OPEN attempt (started, unclassified) — the item was mid-POST when its
// writer died; whether the POST reached OpenCode is unknowable from the
// journal alone, which is precisely why the reconciler (passive, GET-only)
// and the slice-2b certification classes exist. Slice 2a performs NO
// auto-redelivery and NO auto-resolve of ANY class — receipts are recorded,
// classification is left to the reconciler (observed on found; ambiguous-wait
// on not-found) and to 2b's certified classes (only after the crash proofs).
//
// TRANSPORT CLASSIFICATION HONESTY: from the caller's side of an HTTP
// client, "the request was never written" and "the request was written but
// the verdict was lost" are not always distinguishable. The classifier
// encodes the best provable split:
//   - non-2xx response (*opencode.Error)  → server_error (explicit verdict)
//   - transport error whose root is a DIAL failure (connection never
//     established ⇒ provably nothing written) → connect_failed
//   - any OTHER transport error (write/read mid-flight, EOF, timeout after
//     send, tls handshake past connect)     → written_unknown
//   - 2xx                                   → accepted_2xx (NEVER read as
//     durability: prompt_async returns before the forked persist commits)
// A 204 is thus an ambiguous-until-observed outcome, matching the design's
// "a 2xx is NEVER read as durability" rule.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// promptPoster performs ONE upstream prompt_async POST. Production binds it
// to opencode.Client.Prompt (non-2xx arrives as *opencode.Error with Status
// set; transport failures as raw errors). Tests inject fakes that count
// calls — the fence's "no POST from a stale generation" assertion.
type promptPoster func(ctx context.Context, sessionID string, body json.RawMessage) error

// DispatchOutcome reports one executed attempt's journal identity and
// transport class. Slice 2a records it durably and takes NO further action
// (no redelivery, no resolve) — callers observe convergence through the
// reconciler.
type DispatchOutcome struct {
	ItemID        string
	OpencodeMsgID string
	AttemptIdx    int
	Class         QueueAttemptTransportClass
}

// RunQueuedDispatchAttempt executes ONE custody-gated dispatch attempt for
// the oldest pending item: claim (prepared) → journal sending → fence → POST
// → receipt. With no pending item it returns (DispatchOutcome{}, nil).
// The POST is fenced twice: every journal mutation re-checks under the
// store mutex (fenceGateLocked), and an explicit FenceCheck runs immediately
// before the POST — if the token is stale at that point the POST is SKIPPED
// (the poster is never invoked) and errQueueFenced is returned, leaving the
// open attempt journaled (honest: a newer owner will reclassify it).
func RunQueuedDispatchAttempt(ctx context.Context, s *sessionQueueStore, sid string, tok *QueueCustody, poster promptPoster) (DispatchOutcome, error) {
	item, won, err := s.ClaimForCustody(tok)
	if err != nil {
		return DispatchOutcome{}, err
	}
	if !won {
		return DispatchOutcome{}, nil
	}
	idx, err := s.BeginDispatchAttempt(tok, item.ID)
	if err != nil {
		return DispatchOutcome{}, err
	}
	// Compare-and-fence immediately before the upstream POST (debate-4 B3).
	// A stale token must not reach the network even once.
	if err := tok.FenceCheck(); err != nil {
		return DispatchOutcome{ItemID: item.ID, OpencodeMsgID: item.OpencodeMsgID, AttemptIdx: idx}, err
	}
	perr := poster(ctx, sid, buildPromptBody(item))
	class, detail := classifyTransport(perr)
	if rerr := s.RecordAttemptOutcome(tok, item.ID, idx, class, detail); rerr != nil {
		return DispatchOutcome{ItemID: item.ID, OpencodeMsgID: item.OpencodeMsgID, AttemptIdx: idx}, fmt.Errorf("queue drain: attempt %s receipt: %w", item.ID, rerr)
	}
	return DispatchOutcome{ItemID: item.ID, OpencodeMsgID: item.OpencodeMsgID, AttemptIdx: idx, Class: class}, nil
}

// buildPromptBody assembles the prompt_async body for one queued item. SLICE
// 2A MINIMAL SHAPE: a single text part + the caller-id-wins messageID (the
// correlation id minted at claim, so OpenCode persists the user message
// under the exact id the reconciler GETs). sendConfig/attachment threading
// lands with the production drain wiring (the fields persist on the item;
// no production dispatch runs in this slice).
func buildPromptBody(item QueueItem) json.RawMessage {
	body := struct {
		Parts     []map[string]string `json:"parts"`
		MessageID string              `json:"messageID,omitempty"`
	}{
		Parts:     []map[string]string{{"type": "text", "text": item.Text}},
		MessageID: item.OpencodeMsgID,
	}
	b, _ := json.Marshal(body)
	return b
}

// classifyTransport maps a poster result to the transport-class receipt.
// See the file doc comment for the honesty limits of the connect_failed /
// written_unknown split.
func classifyTransport(err error) (QueueAttemptTransportClass, string) {
	switch {
	case err == nil:
		return QueueAttemptAccepted2xx, ""
	case isDialError(err):
		return QueueAttemptConnectFailed, err.Error()
	default:
		var opErr *opencode.Error
		if errors.As(err, &opErr) {
			return QueueAttemptServerError, opErr.Error()
		}
		return QueueAttemptWrittenUnknown, err.Error()
	}
}

// isDialError reports whether err's chain contains a net connection-setup
// failure — the one transport class that PROVABLY wrote nothing to the wire.
// errors.As walks the wrap chain; *url.Error is unwrapped by net/http's
// client, and its inner *net.OpError carries Op "dial" for setup failures.
func isDialError(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return opErr.Op == "dial"
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		var inner *net.OpError
		return errors.As(urlErr.Err, &inner) && inner.Op == "dial"
	}
	return false
}
