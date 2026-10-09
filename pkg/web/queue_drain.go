package web

// Daemon-owned dispatch attempt executor — the attempt-journal WRITER
// (send-net-resilience slice 2a). Behind the capability gate
// (SetDaemonDispatchEnabled — the --daemon-dispatch opt-in, default OFF);
// the DRAIN LOOP (queue_drain_loop.go, slice 2b phase 2) is this file's
// production driver when the flag is on. It NEVER runs as part of the
// legacy browser dispatch path (which stays the production path while the
// flag is off).
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
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// vhAttachURLPrefix mirrors web/src/lib/inlineAttach.ts:94
// (VH_ATTACH_URL_PREFIX = "vh-attach:"): synthetic inline-chip attachment
// urls. The FE's buildParts EXCLUDES them from the prompt body (the chip's
// token was substituted into the text at send; emitting the chip as a file
// part would double-send a bogus file whose url is not a real file:// path).
// The daemon body builder mirrors that exclusion (C-F3).
const vhAttachURLPrefix = "vh-attach:"

// queueDrainPrePostSeam is a TEST-ONLY interleave seam placed at the EXACT
// pre-POST fence window — after BeginDispatchAttempt's durable journal write
// returns and immediately before the compare-and-fence FenceCheck that guards
// the upstream POST. It is nil in production and no production code path ever
// sets it (zero dispatch-behavior change); its sole purpose is deterministic
// red-signal testing of the pre-POST fence branch (T1C-F1): a test sets the
// seam to perform an out-of-band takeover (authority bump / release) at the
// precise point the fence guards, so the executor can be driven PAST
// claim/begin with a live token and the fence made to fail exactly at the
// pre-POST check — without the seam, that window is unreachable from test
// code (there is no statement boundary between begin and the fence).
// Set/Reset discipline: tests MUST restore nil (defer) so the seam never
// leaks across tests.
var queueDrainPrePostSeam func()

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
// ocGen is the OpenCode process generation to journal with the attempt (the
// restart-barrier input; 0 = unknown).
func RunQueuedDispatchAttempt(ctx context.Context, s *sessionQueueStore, sid string, tok *QueueCustody, ocGen uint64, poster promptPoster) (DispatchOutcome, error) {
	item, won, err := s.ClaimForCustody(tok)
	if err != nil {
		return DispatchOutcome{}, err
	}
	if !won {
		return DispatchOutcome{}, nil
	}
	return resumeDispatchAttempt(ctx, s, sid, tok, item, ocGen, poster)
}

// ResumeQueuedDispatchAttempt executes ONE dispatch attempt for an item that
// is ALREADY `dispatching` under a certified redelivery requeue
// (RequeueForCertifiedRedelivery preserved its correlation id — mint-at-
// claim holds: no claim, no re-mint). Same journal protocol and double
// fence as RunQueuedDispatchAttempt, minus the claim: begin → fence → POST
// → receipt. The drain loop calls this for requeued items BEFORE claiming
// new pending ones (FIFO by Order is preserved by the loop's ordering, not
// by this function).
func ResumeQueuedDispatchAttempt(ctx context.Context, s *sessionQueueStore, sid string, tok *QueueCustody, itemID string, ocGen uint64, poster promptPoster) (DispatchOutcome, error) {
	item, ok, err := s.itemForResume(itemID)
	if err != nil || !ok {
		return DispatchOutcome{}, err
	}
	return resumeDispatchAttempt(ctx, s, sid, tok, item, ocGen, poster)
}

// itemForResume loads the requeue-target item iff it is still a live
// requeue (dispatching AND RequeuePending), CONSUMES the marker in the same
// atomic save (so the loop can never resume one requeue twice or mistake
// its own in-flight attempt for a requeue), and returns the item for
// dispatch. A missing item, a state change since classification (e.g. the
// passive reconciler healed it to sent), or an already-consumed marker
// aborts the resume cleanly — the certified verdict was a snapshot, the
// store is the authority. Unfenced by design: this is a store-internal
// bookkeeping transition under the store mutex (the custody-mode journal
// writes that follow are fenced as usual).
func (s *sessionQueueStore) itemForResume(itemID string) (QueueItem, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, false, errQueueArchived
	}
	if err := s.load(); err != nil {
		return QueueItem{}, false, err
	}
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		if s.items[i].State != QueueDispatching || !s.items[i].RequeuePending {
			return QueueItem{}, false, nil
		}
		pre := s.items[i]
		s.items[i].RequeuePending = false
		if err := s.save(); err != nil {
			s.items[i] = pre
			return QueueItem{}, false, err
		}
		item := s.items[i]
		return item, true, nil
	}
	return QueueItem{}, false, nil
}

// resumeDispatchAttempt is the shared begin→fence→POST→receipt core behind
// RunQueuedDispatchAttempt (post-claim) and ResumeQueuedDispatchAttempt
// (post-requeue). The item is dispatching; the correlation id was minted at
// claim and is reused VERBATIM (never re-minted — see queue.go PROPERTIES
// PRESERVED and RequeueForCertifiedRedelivery's mint-at-claim analysis).
func resumeDispatchAttempt(ctx context.Context, s *sessionQueueStore, sid string, tok *QueueCustody, item QueueItem, ocGen uint64, poster promptPoster) (DispatchOutcome, error) {
	idx, err := s.BeginDispatchAttempt(tok, item.ID, ocGen)
	if err != nil {
		return DispatchOutcome{}, err
	}
	// TEST-ONLY interleave point (nil in production): lets a test perform a
	// takeover at the exact pre-POST window (see queueDrainPrePostSeam).
	if queueDrainPrePostSeam != nil {
		queueDrainPrePostSeam()
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

// buildPromptBody assembles the prompt_async body for one queued item. It is
// an EXACT MIRROR of the legacy FE dispatch passthrough (C-F3: web/src/
// components/chat/createSend.ts dispatchQueuedItem + buildParts — the wire
// shape the daemon executor must stay byte-compatible with while the legacy
// browser path is still the production dispatcher):
//
//	parts: one {type:"text", text} part (only when the text is non-empty)
//	       followed by one {type:"file", url, filename, mime} part per
//	       attachment EXCEPT synthetic inline chips (url prefix
//	       vh-attach: — see vhAttachURLPrefix; the chip's token was
//	       substituted into the text at send, so emitting it would
//	       double-send a bogus file part)
//	agent: the item's CAPTURED SendConfig.Agent. The FE sends `agent`
//	       unconditionally (its evidence gate guarantees non-empty); the
//	       daemon threads the captured config and omits the key when the
//	       capture has none — re-resolving an incomplete capture through the
//	       agent-evidence gate is the drain-loop wiring's concern (phase 2),
//	       not the body builder's.
//	model: {providerID, modelID} — only when BOTH halves are present (the FE
//	       treats the pair as atomic; threading a lone half would dispatch
//	       under a half-switched config).
//	variant: only inside the model branch (the FE nests it there).
//	messageID: the claim-minted correlation id (caller-id-wins upstream), so
//	       OpenCode persists the user message under the exact id the
//	       reconciler GETs.
//
// promptBodyModel is the `model` member of the prompt_async body — the
// provider/model PAIR the FE treats as atomic (never a lone half).
type promptBodyModel struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

// promptBody is the prompt_async request body shape (the FE passthrough
// mirror — see buildPromptBody).
type promptBody struct {
	Parts     []map[string]string `json:"parts"`
	Agent     string              `json:"agent,omitempty"`
	Model     *promptBodyModel    `json:"model,omitempty"`
	Variant   string              `json:"variant,omitempty"`
	MessageID string              `json:"messageID,omitempty"`
}

func buildPromptBody(item QueueItem) json.RawMessage {
	parts := make([]map[string]string, 0, 1+len(item.Attachments))
	if item.Text != "" {
		parts = append(parts, map[string]string{"type": "text", "text": item.Text})
	}
	for _, a := range item.Attachments {
		if strings.HasPrefix(a.URL, vhAttachURLPrefix) {
			continue // synthetic inline chip (mirrors the FE buildParts guard)
		}
		parts = append(parts, map[string]string{
			"type":     "file",
			"url":      a.URL,
			"filename": a.Filename,
			"mime":     a.Mime,
		})
	}
	body := promptBody{Parts: parts, Agent: item.SendConfig.Agent}
	if item.SendConfig.ProviderID != "" && item.SendConfig.ModelID != "" {
		body.Model = &promptBodyModel{ProviderID: item.SendConfig.ProviderID, ModelID: item.SendConfig.ModelID}
		if item.SendConfig.Variant != "" {
			body.Variant = item.SendConfig.Variant // nested in the FE's model branch
		}
	}
	if item.OpencodeMsgID != "" {
		body.MessageID = item.OpencodeMsgID
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
