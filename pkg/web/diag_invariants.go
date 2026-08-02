package web

// HTTP handler for the standing-proof invariant diagnostic
// (GET /vh/diag/invariants). This turns the daemon-side master invariant
// (INV-1/2/3/4/8) from "audited once" into "provable on demand" by diffing the
// daemon's RESIDENT message/parts state against a fresh OpenCode source fetch,
// per session, and reporting per-invariant pass/fail/deferred with evidence.
//
// Route (registered in server.go Handler()):
//
//	GET /vh/diag/invariants?dir=<dir>&sessions=<sid1,sid2,…>&limit=<n>
//
// Contract:
//   - GET-only (405+Allow otherwise). Mirrors /vh/diag/busy + /vh/diag/latency:
//     GET-only under the /vh/* mux, so NO per-handler CSRF check is needed
//     (CSRF defense applies to unsafe methods only).
//   - Read-only / side-effect-free. It does NOT call EnsureMessages, does NOT
//     publish messages.batch/messages.loaded, does NOT bump s.seq, and does NOT
//     mutate store state (mirrors the messages_http.go:95 no-side-effect rule).
//   - It uses aggForExisting (NOT aggFor): a diagnostic GET must not have the
//     side effect of OPENING a project / firing managed-project hooks. An
//     unopened ?dir= returns 404 instead. (Deliberate divergence from the spec
//     in standing-proof.md §2, which said aggFor — see Implementation notes
//     appended there.)
//   - For each requested session (or all LoadedSessions if `sessions` omitted,
//     capped by `limit`, default 50 / max 200 to bound per-request OpenCode
//     fetch cost) it performs ONE fresh client.Messages fetch and diffs resident
//     vs source part/message id sets.
//   - stampMeta middleware stamps X-VH-Epoch/X-VH-Seq on every /vh/* response.
//
// What it PROVES (live, against the OpenCode source of truth):
//   - INV-1 (ingest: resident == source)        — diff empty.
//   - INV-2 (hydrate: no partial part set)      — no resident message is
//     missing any of its source parts.
//   - INV-3 (gate consistency)                  — snapshot gate fact, live
//     IsMessagesLoaded memo, and resident newest-assistant evidence all agree.
// What it DEFERS (structural, not observable from one snapshot):
//   - INV-4 (emit carries seq+ring)             — proven by the Go property test
//     TestEveryMessageClassEmitIsSeqStampedAndRinged.
//   - INV-8 (messages.batch no-clobber)         — proven by the Go property test
//     TestMessagesBatchDoesNotClobberResident.
// Legs E–I (emit/transport/apply/render) are NOT in scope here; INV-7 (render)
// is proven client-side by the PartRenderContract web test.

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// invariantResult is one leg's on-demand verdict.
type invariantResult struct {
	Name     string `json:"name"`
	Status   string `json:"status"`   // "pass" | "fail" | "deferred"
	Evidence string `json:"evidence"` // human-readable justification / pointer to the structural proof
}

type invariantsNewestAssistant struct {
	ID        string   `json:"id"`
	PartCount int      `json:"part_count"`
	PartTypes []string `json:"part_types"`
}

type invariantsResidentSummary struct {
	MessageCount             int                        `json:"message_count"`
	PartCount                int                        `json:"part_count"`
	NewestCompletedAssistant *invariantsNewestAssistant `json:"newest_completed_assistant,omitempty"`
}

type invariantsSourceSummary struct {
	MessageCount int    `json:"message_count"`
	PartCount    int    `json:"part_count"`
	FetchedVia   string `json:"fetched_via"`
	Error        string `json:"error,omitempty"` // empty on success; set when the OpenCode fetch failed
}

type invariantsDiff struct {
	MissingPartIDs    []string `json:"missing_part_ids"`    // "{msgID}/{partID}" — source parts not resident
	ExtraPartIDs      []string `json:"extra_part_ids"`      // "{msgID}/{partID}" — resident parts not in source
	MissingMessageIDs []string `json:"missing_message_ids"` // source messages not resident
	ExtraMessageIDs   []string `json:"extra_message_ids"`   // resident messages not in source
}

type invariantsGateSummary struct {
	MsgLoaded               bool `json:"msgLoaded"`                 // live store.IsMessagesLoaded(sid) memo
	MessagesLoaded          bool `json:"messagesLoaded"`            // point-in-time snapshot gate fact
	NewestAssistantResident bool `json:"newest_assistant_resident"` // newest assistant turn has its parts resident
	Consistent              bool `json:"consistent"`                // the three above agree
}

type sessionInvariant struct {
	SessionID            string                    `json:"sessionID"`
	MasterInvariantHolds bool                      `json:"master_invariant_holds"`
	Resident             invariantsResidentSummary `json:"resident"`
	Source               invariantsSourceSummary   `json:"source"`
	Diff                 invariantsDiff            `json:"diff"`
	Gate                 invariantsGateSummary     `json:"gate"`
	PerInvariant         []invariantResult         `json:"per_invariant"`
}

type invariantsResp struct {
	Epoch     string             `json:"epoch"`
	Seq       uint64             `json:"seq"`
	CheckedAt int64              `json:"checked_at"` // unix millis
	Dir       string             `json:"dir,omitempty"`
	Truncated bool               `json:"truncated,omitempty"` // more sessions existed than `limit`
	Sessions  []sessionInvariant `json:"sessions"`
}

// msgInfoHdr is the minimal id/role projection of an opencode message info blob.
type msgInfoHdr struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

// partHdr is the minimal id/type projection of an opencode part blob.
type partHdr struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// sourceMsgHdr is the shape returned by opencode.Client.Messages: an item with
// nested info + a parts array. Each part is raw JSON parsed for its id/type only.
type sourceMsgHdr struct {
	Info  msgInfoHdr        `json:"info"`
	Parts []json.RawMessage `json:"parts"`
}

// Per-session fetch timeout. One slow/stuck OpenCode must not stall the whole
// diagnostic; each session gets its own bounded deadline.
const invariantsFetchTimeout = 8 * time.Second

func (s *Server) handleDiagInvariants(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dir := reqDir(r)
	agg := s.aggForExisting(dir)
	if agg == nil {
		// Side-effect-free: do NOT open the project (aggFor would fire managed
		// hooks). A diagnostic against an unopened dir is a 404 with a hint.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		writeJSONResp(w, invariantsResp{
			Dir:      dir,
			Sessions: []sessionInvariant{},
		})
		return
	}
	st := agg.Store()

	// Resolve the session set. `sessions=` narrows; otherwise default to the
	// loaded (hydrated) sessions — the ones with message state worth diffing.
	var sids []string
	if raw := r.URL.Query().Get("sessions"); raw != "" {
		for _, p := range strings.Split(raw, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			// Sanitize like the queue/messages paths (defense in depth before
			// the id is interpolated into the upstream OpenCode URL path).
			sids = append(sids, safeID.ReplaceAllString(p, ""))
		}
	} else {
		loaded := st.LoadedSessions()
		sids = make([]string, 0, len(loaded))
		sids = append(sids, loaded...)
	}
	sort.Strings(sids)

	// Bound per-request fetch cost. A fleet can carry many loaded sessions; each
	// triggers one full OpenCode message fetch. Default 50, max 200, min 1.
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
			if limit > 200 {
				limit = 200
			}
		}
	}
	truncated := false
	if len(sids) > limit {
		sids = sids[:limit]
		truncated = true
	}

	// One point-in-time snapshot of the resident state for all requested
	// sessions (Messages + Gate). The fresh OpenCode fetch happens per session
	// OUTSIDE any store lock (read-only).
	msgFor := make(map[string]bool, len(sids))
	for _, sid := range sids {
		msgFor[sid] = true
	}
	snap := st.Snapshot(msgFor)

	resp := invariantsResp{
		Epoch:     snap.Epoch,
		Seq:       snap.Seq,
		CheckedAt: time.Now().UnixMilli(),
		Dir:       dir,
		Truncated: truncated,
		Sessions:  make([]sessionInvariant, 0, len(sids)),
	}
	client := agg.Client()
	for _, sid := range sids {
		resp.Sessions = append(resp.Sessions, s.checkSessionInvariants(sid, snap, st, client))
	}
	// Computed fresh from live state on every call; a cached response would
	// defeat the point of an on-demand invariant probe.
	w.Header().Set("Cache-Control", "no-store")
	writeJSONResp(w, resp)
}

// checkSessionInvariants computes the per-session resident/source diff and the
// live-checkable invariant verdicts (INV-1/2/3). INV-4/8 are structural and
// always deferred here (proven by Go property tests). The fresh OpenCode fetch
// is read-only and bounded by invariantsFetchTimeout.
func (s *Server) checkSessionInvariants(sid string, snap state.Snapshot, st *state.Store, client interface {
	Messages(ctx context.Context, sessionID string) ([]json.RawMessage, error)
}) sessionInvariant {
	residentMsgs := snap.Messages[sid]
	gate := snap.Gate[sid]

	// --- resident projection ---
	residentParts := make(map[string]map[string]bool) // msgID -> set(partID)
	residentMsgIDs := make(map[string]bool)
	residentPartTotal := 0
	var newestAssistant *invariantsNewestAssistant
	partTypeSet := make(map[string]bool)
	for _, mw := range residentMsgs {
		info := parseMsgInfoHdr(mw.Info)
		if info.ID != "" {
			residentMsgIDs[info.ID] = true
		}
		pset := make(map[string]bool)
		for _, pb := range mw.Parts {
			ph := parsePartHdr(pb)
			if ph.ID != "" {
				pset[ph.ID] = true
			}
			if ph.Type != "" {
				partTypeSet[ph.Type] = true
			}
			residentPartTotal++
		}
		if info.ID != "" {
			residentParts[info.ID] = pset
		}
		// Newest assistant = the LAST assistant message in resident order.
		if info.Role == "assistant" {
			types := make([]string, 0, len(mw.Parts))
			for _, pb := range mw.Parts {
				if t := parsePartHdr(pb).Type; t != "" {
					types = append(types, t)
				}
			}
			newestAssistant = &invariantsNewestAssistant{
				ID:        info.ID,
				PartCount: len(mw.Parts),
				PartTypes: types,
			}
		}
	}

	residentSummary := invariantsResidentSummary{
		MessageCount: len(residentMsgs),
		PartCount:    residentPartTotal,
	}
	if newestAssistant != nil {
		residentSummary.NewestCompletedAssistant = newestAssistant
	}

	// --- source projection (one fresh OpenCode fetch, read-only) ---
	srcSummary := invariantsSourceSummary{FetchedVia: "GET /session/:id/message (no limit)"}
	var sourceParts map[string]map[string]bool // msgID -> set(partID)
	sourceMsgIDs := make(map[string]bool)
	fetchOK := true
	fctx, cancel := context.WithTimeout(context.Background(), invariantsFetchTimeout)
	defer cancel()
	srcMsgs, ferr := client.Messages(fctx, sid)
	if ferr != nil {
		fetchOK = false
		srcSummary.Error = ferr.Error()
	} else {
		sourceParts = make(map[string]map[string]bool, len(srcMsgs))
		srcPartTotal := 0
		for _, raw := range srcMsgs {
			var sm sourceMsgHdr
			if err := json.Unmarshal(raw, &sm); err != nil {
				continue
			}
			if sm.Info.ID == "" {
				continue
			}
			sourceMsgIDs[sm.Info.ID] = true
			pset := make(map[string]bool, len(sm.Parts))
			for _, pb := range sm.Parts {
				pid := parsePartHdr(pb).ID
				if pid != "" {
					pset[pid] = true
				}
				srcPartTotal++
			}
			sourceParts[sm.Info.ID] = pset
		}
		srcSummary.MessageCount = len(sourceMsgIDs)
		srcSummary.PartCount = srcPartTotal
	}

	// --- diff (qualified "msgID/partID" so cross-message collisions can't hide) ---
	diff := invariantsDiff{
		MissingPartIDs:    []string{},
		ExtraPartIDs:      []string{},
		MissingMessageIDs: []string{},
		ExtraMessageIDs:   []string{},
	}
	if fetchOK {
		for mid, pset := range sourceParts {
			if !residentMsgIDs[mid] {
				diff.MissingMessageIDs = append(diff.MissingMessageIDs, mid)
			}
			rset := residentParts[mid]
			for pid := range pset {
				if !rset[pid] {
					diff.MissingPartIDs = append(diff.MissingPartIDs, mid+"/"+pid)
				}
			}
		}
		for mid, rset := range residentParts {
			if !sourceMsgIDs[mid] {
				diff.ExtraMessageIDs = append(diff.ExtraMessageIDs, mid)
			}
			sset := sourceParts[mid]
			for pid := range rset {
				if !sset[pid] {
					diff.ExtraPartIDs = append(diff.ExtraPartIDs, mid+"/"+pid)
				}
			}
		}
		sort.Strings(diff.MissingPartIDs)
		sort.Strings(diff.ExtraPartIDs)
		sort.Strings(diff.MissingMessageIDs)
		sort.Strings(diff.ExtraMessageIDs)
	}

	// --- gate consistency (INV-3) ---
	msgLoaded := st.IsMessagesLoaded(sid)
	newestResident := newestAssistant != nil && newestAssistant.PartCount > 0
	if fetchOK && newestAssistant != nil {
		// Stronger: the newest assistant must hold ALL its source parts, not just >0.
		sset := sourceParts[newestAssistant.ID]
		rset := residentParts[newestAssistant.ID]
		for pid := range sset {
			if !rset[pid] {
				newestResident = false
				break
			}
		}
	}
	gateSummary := invariantsGateSummary{
		MsgLoaded:               msgLoaded,
		MessagesLoaded:          gate.MessagesLoaded,
		NewestAssistantResident: newestResident,
	}
	// U1: when there is no completed assistant turn (newestAssistant == nil), the
	// resident-parts leg is N/A — the gate's latestAssistantResidentLocked returns
	// true vacuously ("no assistant → true"), so a loaded session with no
	// assistant turn is consistent, not a disagreement. Apply the resident-parts
	// leg only when an assistant turn exists to check.
	newestLegOK := newestAssistant == nil || gate.MessagesLoaded == newestResident
	gateSummary.Consistent = (msgLoaded == gate.MessagesLoaded) && newestLegOK

	// --- per-invariant verdicts ---
	inv := make([]invariantResult, 0, 5)

	// INV-1 ingest: resident == source.
	if !fetchOK {
		inv = append(inv, invariantResult{Name: "INV1_ingest_resident_eq_source", Status: "deferred", Evidence: "OpenCode fetch failed: " + srcSummary.Error})
	} else if len(diff.MissingPartIDs) == 0 && len(diff.ExtraPartIDs) == 0 && len(diff.MissingMessageIDs) == 0 && len(diff.ExtraMessageIDs) == 0 {
		inv = append(inv, invariantResult{Name: "INV1_ingest_resident_eq_source", Status: "pass", Evidence: "resident part/message id sets equal source"})
	} else {
		inv = append(inv, invariantResult{Name: "INV1_ingest_resident_eq_source", Status: "fail", Evidence: diffCount(diff)})
	}

	// INV-2 hydrate: no partial part set (a resident message missing some of its
	// source parts = a middle-drop / partial hydrate).
	if !fetchOK {
		inv = append(inv, invariantResult{Name: "INV2_hydrate_no_partial", Status: "deferred", Evidence: "OpenCode fetch failed: " + srcSummary.Error})
	} else {
		partial := 0
		for _, q := range diff.MissingPartIDs {
			mid := strings.SplitN(q, "/", 2)[0]
			if residentMsgIDs[mid] {
				partial++ // the message envelope IS resident but parts are missing
			}
		}
		if partial == 0 {
			inv = append(inv, invariantResult{Name: "INV2_hydrate_no_partial", Status: "pass", Evidence: "no resident message has a partial part set"})
		} else {
			inv = append(inv, invariantResult{Name: "INV2_hydrate_no_partial", Status: "fail", Evidence: strconv.Itoa(partial) + " resident message(s) missing source parts (partial hydrate)"})
		}
	}

	// INV-3 gate consistency.
	if gateSummary.Consistent {
		inv = append(inv, invariantResult{Name: "INV3_gate_loaded_iff_resident", Status: "pass", Evidence: "msgLoaded, snapshot messagesLoaded, and newest-assistant-resident agree"})
	} else {
		inv = append(inv, invariantResult{Name: "INV3_gate_loaded_iff_resident", Status: "fail", Evidence: "gate disagreement: msgLoaded=" + strconv.FormatBool(msgLoaded) + " messagesLoaded=" + strconv.FormatBool(gate.MessagesLoaded) + " newestResident=" + strconv.FormatBool(newestResident)})
	}

	// INV-4 emit: structural — deferred to the Go property test.
	inv = append(inv, invariantResult{Name: "INV4_emit_seq_present", Status: "deferred", Evidence: "structural; proven by Go test TestEveryMessageClassEmitIsSeqStampedAndRinged"})

	// INV-8 batch no-clobber: structural — deferred to the Go property test.
	inv = append(inv, invariantResult{Name: "INV8_batch_no_clobber", Status: "deferred", Evidence: "structural; proven by Go test TestMessagesBatchDoesNotClobberResident"})

	master := fetchOK &&
		len(diff.MissingPartIDs) == 0 && len(diff.ExtraPartIDs) == 0 &&
		len(diff.MissingMessageIDs) == 0 && len(diff.ExtraMessageIDs) == 0 &&
		gateSummary.Consistent

	return sessionInvariant{
		SessionID:            sid,
		MasterInvariantHolds: master,
		Resident:             residentSummary,
		Source:               srcSummary,
		Diff:                 diff,
		Gate:                 gateSummary,
		PerInvariant:         inv,
	}
}

func parseMsgInfoHdr(b json.RawMessage) msgInfoHdr {
	var m msgInfoHdr
	_ = json.Unmarshal(b, &m)
	return m
}

func parsePartHdr(b json.RawMessage) partHdr {
	var p partHdr
	_ = json.Unmarshal(b, &p)
	return p
}

func diffCount(d invariantsDiff) string {
	return "missing parts=" + strconv.Itoa(len(d.MissingPartIDs)) +
		" extra parts=" + strconv.Itoa(len(d.ExtraPartIDs)) +
		" missing msgs=" + strconv.Itoa(len(d.MissingMessageIDs)) +
		" extra msgs=" + strconv.Itoa(len(d.ExtraMessageIDs))
}
