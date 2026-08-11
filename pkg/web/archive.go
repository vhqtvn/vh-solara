package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// defaultReassertDelay is the wait before the post-archive re-assert goroutine
// re-reads OpenCode and re-PATCHes any affected id whose time.archived was
// clobbered by a still-running busy/compacting subagent (OpenCode rewrites the
// full session record from a pre-PATCH snapshot → archived back to null). The
// PATCH itself returned 200 — the clobber is invisible to handleArchive — so
// the re-assert is what makes the archive actually persist once the busy write
// settles. The store-side tombstone (set by RemoveSessions) holds the live
// tree during this window; this goroutine is defense-in-depth for OpenCode's
// own state. The per-Server delay (Server.reassertDelay) defaults to this;
// tests override it via SetReassertDelay.
const defaultReassertDelay = 1 * time.Second

// Archive cascade job retry policy (Defect 1 fix — server-owned background job).
//
// budget is the maximum SetArchived attempts per id. base is the initial
// exponential backoff; max is its ceiling. Total worst-case backoff for ONE id
// ≈ base + 2·base + 4·base + … capped at max, summed over budget attempts.
//
// Calibration (build-validate 5): budget=5, base=500ms, max=8s → ≈15.5s of
// backoff span per failing id. That comfortably covers an OpenCode/LLM
// rate-limit window (seconds) and a transient 5xx blip, without indefinitely
// blocking a genuinely-stuck id: after ~15s it hands off to the stuck
// classification (descendant → orphan banner via Slices 1/2; root → explicit
// job failure). The cascade is SERIAL (one SetArchived at a time), matching the
// prior loop and avoiding burst rate-limiting (429) against OpenCode — so a
// 1000-descendant cascade where a few ids fail pays the backoff only on the
// failing ids, not the whole batch.
const (
	defaultArchiveRetryBudget = 5
	defaultArchiveRetryBase   = 500 * time.Millisecond
	defaultArchiveRetryMax    = 8 * time.Second
)

// archiveRetryConfig is the captured-at-launch retry policy for one cascade
// job. Frozen from the Server's per-instance config under bgMu so the job never
// reads shared mutable state after dispatch (same pattern as reassertDelay).
type archiveRetryConfig struct {
	budget int
	base   time.Duration
	max    time.Duration
}

// archiveJobFailure records an id that reached terminal failure in a cascade
// job. This is the operator-visibility surface for stuck ROOTS (build-validate
// 4): a structured log fires per failure, and this registry is the seed the
// archive-failures SSE snapshot/updated frames (Slice 1) expose to the mobile
// SPA. A DESCENDANT-of-archived id that exhausted its budget is NOT recorded
// here — the orphan banner (Slices 1/2) surfaces it instead, and recording it
// as a "failure" would double-count the recovery affordance.
//
// The registry is a per-project (Dir, ID) composite-keyed UPSERT map (Slice 1
// reshape): a repeat permanent failure for the same (Dir,ID) refreshes one
// coherent record (Reason/At), NOT a duplicate append. Dir is the reqDir value
// captured at handleArchive (the originating POST's project); "" is the default
// project. Tenant isolation: the SSE snapshot + updated frames are filtered to
// one project's Dir — a failure in project A never reaches project B's stream.
// ArchiveFailures returns a snapshot copy (all projects, sorted) for tests /
// diagnostics; ArchiveFailuresForDir is the per-project wire-DTO builder.
type archiveJobFailure struct {
	Dir     string // the project dir (reqDir at record time); "" is the default project
	ID      string
	Reason  string // "permanent:403", "exhausted:5", "cancelled:shutdown" — classified token only
	RootSrc string // the originating POST /vh/archive sessionID
	At      time.Time
}

// archiveFailureKey is the composite upsert key for the archiveFailures map: one
// coherent record per (project, stuck-root). A repeat permanent failure for the
// same key UPSERTS (refreshes Reason/At), so the operator sees one banner, not
// an append-log of duplicates.
type archiveFailureKey struct {
	Dir string
	ID  string
}

// Archiving uses OpenCode's NATIVE archive (PATCH /session/:id time.archived):
// it persists in OpenCode and is visible to every client. Archiving cascades to
// a session's subsessions; the browser lists archived sessions on demand from
// OpenCode (GET /session?archived=true).

// POST /vh/archive {sessionID} — archive a session and all its subsessions.
// POST /vh/unarchive {sessionID} — restore them.
func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID           string `json:"sessionID"`
		ExpectedFingerprint string `json:"expectedFingerprint,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10) // a session id is tiny
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	dir := reqDir(r)
	agg := s.aggFor(dir)
	unarchive := r.URL.Path == "/vh/unarchive"

	var affected []string
	if unarchive {
		// Topology guard (runs BEFORE any DB open): direct-DB unarchive writes
		// to a PROCESS-LOCAL SQLite file. In the spawned/co-located topology
		// that file IS the running instance's DB (env inherited). In the
		// external topology (--opencode-url) the session ids come from a REMOTE
		// instance but the DB resolver targets a LOCAL file that may not match
		// — refuse fast unless the operator explicitly bound
		// VH_OPENCODE_DB_PATH. See docs/architecture/opencode-sqlite-unarchive.md.
		if err := opencode.UnarchiveGuard(s.externalOC); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// Archived sessions aren't in the live store; compute the subtree from
		// OpenCode's archived list, then clear time_archived on each.
		//
		// Unarchive writes DIRECTLY to OpenCode's SQLite DB
		// (opencode.UnarchiveSessions) rather than going through the HTTP API:
		// OpenCode 1.17.x has no HTTP way to clear archived (PATCH with a JSON
		// null for time.archived is rejected with 400 — its request schema is
		// Schema.optional(Schema.Finite), which does not accept null). See
		// docs/architecture/opencode-sqlite-unarchive.md for the coupling
		// contract and the drift guard. Archiving (the else branch below) still
		// uses the working HTTP PATCH with a finite timestamp.
		ids, err := agg.Client().ListArchivedSessions(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		affected = archivedDescendants(ids, body.SessionID)
		if err := opencode.UnarchiveSessions(r.Context(), affected); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// The direct-DB unarchive cleared time_archived in OpenCode. Clear the
		// store tombstone for these ids so the imminent Rehydrate re-inserts
		// them (without this, Hydrate's and upsertSessionLocked's tombstone
		// guards would keep them absent). This is the ONLY place tombstones are
		// cleared: the generic Hydrate deliberately does not, because it can't
		// distinguish a genuine unarchive from a stale clobber (both carry
		// archived=null) during the re-assert window.
		agg.Store().ClearArchiveTombstones(affected)
		// Re-hydrate so the restored sessions re-enter the live tree. The direct
		// DB write emits no session.updated event, so the local store would
		// otherwise still consider these sessions archived until a refresh.
		_ = agg.Rehydrate(r.Context())
	} else {
		// The subtree is live, so cascade is computed from the store.
		affected = agg.Store().Descendants(body.SessionID)
		// Fallback: if the requested session isn't in the live store (e.g. an
		// orphan whose parent was archived server-side — the orphan banner
		// surfaces such sessions from the CLIENT store, but vh-solara's store
		// may have already pruned it via a prior archive cascade or a demotion
		// sweep), the live-store walk returns nothing. The RT4 resume path
		// (resumeArchiveAffected) checks whether the root is confirmed archived
		// in OpenCode and, if so, derives the remaining LIVE stragglers from
		// OpenCode's authoritative session lists — so reissuing archive on a
		// partially-archived root completes the remainder. Falls back to
		// [body.SessionID] for the ghost / never-existed / fully-archived-no-
		// stragglers cases (re-PATCH / 404-tolerate the root alone).
		if len(affected) == 0 {
			affected = s.resumeArchiveAffected(r.Context(), agg, body.SessionID)
		}
		// C5 — archive-preview drift fence. If the caller carried a preview
		// fingerprint (the FE's SessionContextMenu threads the one returned by
		// GET /vh/session/:id/descendants), reject when the live affected set's
		// MEMBERSHIP changed between preview and commit: a spawn, a delete, or
		// a reparent in/out of the subtree. 409 Conflict (the established
		// CAS-failure status in this repo — see verbs.go If-Idle-Seq) and NO
		// archive is performed (we return before the SetArchived loop). The FE
		// re-fetches descendants and re-shows the confirmation dialog against
		// the current set; it does NOT auto-retry (the operator must re-consent
		// to the new set — that is the entire point of the fence).
		//
		// The fingerprint is a pure function of the id-set, so an internal
		// reparent (an id stays inside the subtree) does NOT reject — only
		// membership changes do. Absent expectedFingerprint (legacy /
		// unattended programmatic archives) → current behavior, no fence
		// (backward-compat, matches the If-Idle-Seq opt-in precedent).
		//
		// Point-in-time fence over the T0→T1 preview→commit window (C5's scope).
		// A mutation landing AFTER this check but before the SetArchived loop
		// below is a RESIDUAL RACE that is explicitly ACCEPTED here, not a gap
		// to close: (1) true atomicity is impractical across the OpenCode HTTP
		// boundary — spawns originate IN OPENCODE (a subagent launch), not in
		// this store, so a store-level lock cannot keep a new child out of the
		// subtree while the loop runs; that new id is absent from the `affected`
		// snapshot (the Descendants call above) and is never archived, though
		// its parent is. (2) A re-Descendants guard per loop iteration is still
		// racy per-id (membership can flip between the re-check and SetArchived)
		// and adds N extra reads without eliminating the window. (3) The race is
		// ACCEPTED because blast radius is bounded to ONE un-archived straggler
		// (recoverable), never data loss: the orphan banner surfaces it. The
		// server recomputes Node.flags.orphan via isOrphanLocked
		// (pkg/state/tree_emitter.go) when an archived root leaves a resident
		// descendant; web/src/components/OrphanBanner.tsx renders those nodes as
		// an "Archive orphans" affordance the operator clicks to re-archive the
		// straggler (the same recovery path the len(affected)==0 fallback above
		// relies on). The fingerprint stays coherent with the `affected` slice
		// the loop archives (both derive from the one Descendants return).
		if body.ExpectedFingerprint != "" {
			cur := state.FingerprintIDs(affected)
			if cur != body.ExpectedFingerprint {
				writeJSON(w, http.StatusConflict, jsonBytes(map[string]any{
					"ok":    false,
					"error": "descendants_changed",
					// The current live set + its fingerprint, so the FE CAN
					// diff client-side without a second round-trip — though it
					// re-fetches descendants anyway for the rich title list
					// (the GET is authoritative, not the 409 body).
					"current": map[string]any{
						"fingerprint": cur,
						"affected":    affected,
					},
				}))
				return
			}
		}
		// Defect 1 fix: the cascade is a SERVER-OWNED background job, not a
		// request-bound synchronous loop. The handler responds 200 + the frozen
		// affected set IMMEDIATELY (job accepted); the job runs under bgCtx (so a
		// cancelled/disconnected request — a mobile screen-off — does NOT cancel
		// the cascade), retries transient per-id SetArchived failures under a
		// bounded budget, is idempotent on re-issue for already-archived ids
		// (SetArchived re-writes 200; RemoveSessionIfPresent/Cleanup are no-ops
		// on absent ids), retains failed ids per-id (never RemoveSessions/Cleanup
		// on failure), and hands permanently-stuck descendants to the orphan
		// banner (Slices 1/2) while surfacing stuck roots as explicit failures.
		// See runArchiveCascade for the full contract.
		//
		// The C5 fence above ran synchronously and validated `affected` — that is
		// the FROZEN job scope. The async job MUST NOT expand it: a post-acceptance
		// spawn/reparent child is absent from this snapshot and is caught by the
		// Slice 1/2 backstop sweep, never silently included here (no internal
		// re-Descendants).
		s.bgMu.Lock()
		bgCtx := s.bgCtx
		delay := s.reassertDelay
		cfg := archiveRetryConfig{
			budget: s.archiveRetryBudget,
			base:   s.archiveRetryBase,
			max:    s.archiveRetryMax,
		}
		s.bgWG.Add(1)
		atomic.AddInt64(&s.archiveJobsActive, 1) // hoisted before launch: awaitArchiveJobs must see >=1
		s.bgMu.Unlock()
		go s.runArchiveCascade(bgCtx, agg, affected, body.SessionID, dir, delay, cfg)
	}
	writeJSONResp(w, map[string]any{"ok": true, "affected": affected})
}

// runArchiveCascade is the Server-owned archive cascade job (Defect 1 fix). It
// replaces the prior request-bound, abort-on-first-error synchronous loop with
// a background goroutine that:
//  1. survives mobile disconnect (runs under bgCtx, NOT the request context),
//  2. retries transient per-id SetArchived failures (bounded budget + backoff),
//  3. is idempotent on re-issue (SetArchived re-writes 200 on already-archived;
//     RemoveSessionIfPresent/Cleanup are no-ops on absent ids — re-issuing a
//     fully-archived root does no work and no duplicate cleanup; re-issuing a
//     root that is STILL LIVE completes its remaining live descendants),
//  4. retains failed ids (NEVER RemoveSessions/Cleanup on failure — per id),
//  5. hands permanently-stuck DESCENDANTS to the orphan banner (Slices 1/2),
//     and surfaces stuck ROOTS as explicit job failures (never fake orphans —
//     the e88f19e false-positive gate).
//
// It also SUBSUMES the post-archive re-assert (Issue A): after the cascade loop,
// it runs reassertArchiveWork for the successfully-archived ids (re-PATCHes any
// id a busy/compacting subagent clobbered — SetArchived returned 200 but didn't
// persist). The prior standalone reassertArchive dispatcher is retired: one
// goroutine owns the whole archive lifecycle for this request, so there is no
// double-archive and no second bgWG-tracked goroutine to coordinate.
//
// `affected` is the FROZEN job scope (captured at acceptance, after the C5
// fence). The job MUST NOT expand it: post-acceptance spawn/reparent children
// are absent from this snapshot and are caught by the Slice 1/2 backstop sweep,
// not silently included here (no internal re-Descendants).
//
// Lifecycle: bgWG.Add(1) + archiveJobsActive increment happen in handleArchive
// BEFORE launch; defer bgWG.Done() here, defer archiveJobsActive decrement here.
// bgCtx is the Server's background lifetime so Shutdown cancels (via bgCancel)
// AND awaits (via bgWG.Wait) the job. archiveJobsActive is a test seam
// (awaitArchiveJobs polls it); production never reads it.
func (s *Server) runArchiveCascade(bgCtx context.Context, agg *aggregator.Aggregator, affected []string, srcID, dir string, delay time.Duration, cfg archiveRetryConfig) {
	defer s.bgWG.Done()
	defer atomic.AddInt64(&s.archiveJobsActive, -1)

	ts := time.Now().UnixMilli()
	root, rootErr := projectRoot(dir)
	succeeded := make([]string, 0, len(affected))
	// F1 fix: capture the ORIGINAL parent chain for every id in the frozen scope
	// BEFORE any RemoveSessions mutates the tree. classifyArchiveFailure uses
	// this (plus the succeeded set) to recognize a failed descendant of a root
	// archived by THIS job — the authoritative archivedSnapshot is not refreshed
	// mid-job, and RemoveSessionIfPresent re-roots children, so
	// ChainTerminatesAtArchived alone would misclassify a just-orphaned child as
	// a root/unresolvable failure.
	parentOf := make(map[string]string, len(affected))
	for _, id := range affected {
		if p := agg.Store().ParentOf(id); p != "" {
			parentOf[id] = p
		}
	}
	// succeededSet mirrors `succeeded` as a lookup for classifyArchiveFailure.
	succeededSet := make(map[string]bool, len(affected))

	for _, id := range affected {
		if s.archiveOneID(bgCtx, agg, id, ts, srcID, dir, cfg, succeededSet, parentOf) {
			// Per-id retain-on-failure (non-negotiable): cleanup runs ONLY for
			// this successful id. A failed id is never RemoveSessions'd — its
			// queue state survives so a still-active session isn't muted. This
			// mirrors the prior all-or-nothing retain-on-failure but applied
			// per-id, so a partial cascade cleans up exactly what succeeded.
			//
			// F2 fix (concurrent-reissue CAS): RemoveSessionIfPresent returns
			// true ONLY if THIS job actually deleted the id. A concurrent re-
			// issue whose job already removed it returns false → skip
			// CleanupSession (no double queue-cleanup — the RT4 contract).
			//
			// Slice 1 clear-on-success (LOAD-BEARING): this `if true` block is
			// the success funnel ALL three success branches (200-ok, 404/410-
			// ghost, 409-already-archived) fall through to — archiveOneID
			// returns true only on genuine archive completion. A stuck-root
			// record for (dir,id) recorded by a PRIOR failed attempt is
			// resolved HERE, so the mobile banner clears the moment a retry
			// actually succeeds. NEVER clear at the 200-accepted handler
			// response (archive.go handleArchive) — acceptance ≠ success (the
			// cascade runs async under bgCtx; the handler returns before any
			// SetArchived). clearArchiveFailure is a no-op when no record
			// exists (the happy path), so this is cheap on first-success.
			s.clearArchiveFailure(dir, id)
			if agg.Store().RemoveSessionIfPresent(id) {
				if rootErr == nil {
					s.queues.CleanupSession(root, safeID.ReplaceAllString(id, ""))
				}
			}
			succeededSet[id] = true
			succeeded = append(succeeded, id)
		}
		// archiveOneID already classified + recorded a terminal failure. The
		// failed id stays live (retained) — the orphan sweep flags it if it is
		// a descendant of an archived root; otherwise it remains a normal
		// session with an explicit job-failure record.
	}

	if len(succeeded) > 0 {
		// Phase 4 Layer 1 — unpin succeeded ids (idempotent; no-op if absent).
		s.removePinsAndBroadcast(succeeded)
		// Subsumed re-assert (Issue A): re-PATCH any succeeded id a busy
		// subagent clobbered (200 returned but archived reverted to null).
		s.reassertArchiveWork(bgCtx, delay, agg, succeeded, srcID)
	}
}

// archiveOneID performs the bounded-retry SetArchived for a single id and
// returns true on success, false on terminal failure. It NEVER RemoveSessions
// or CleanupSession — the caller does that only on success (retain-on-failure).
//
// Success cases: SetArchived 200; 404/410 (ghost — verifiably gone); 409 where
// a re-derive from OpenCode's authoritative list confirms the id is already
// archived (a concurrent archive won).
//
// Terminal-failure handling: on a PERMANENT error (400/403) or budget
// exhaustion, the id is classified. A DESCENDANT of an archived root — either
// per the authoritative archivedSnapshot (Store.ChainTerminatesAtArchived, the
// SAME authority Slices 1/2 use) OR per THIS job's succeeded set via the
// captured parent chain (a root archived moments ago that is not yet in the
// snapshot) — is LEFT live so the orphan sweep flags it (OrphanBanner surfaces
// it). A ROOT or unresolvable chain is recorded as an explicit job failure
// (recordArchiveFailure + structured log) and is NEVER orphan-flagged (e88f19e).
//
// Error classification (build-validate 5/6):
//   - 404/410: ghost → success (no retry).
//   - 409: re-derive; already-archived → success; else transient retry.
//   - 400/403: permanent → terminal failure (no retry).
//   - 401/429/5xx/network/unknown: transient → retry under budget.
//
// 409 assumption (build-validate 6): the fakeOC does not model a SetArchived
// 409 with distinct semantics, so the re-derive rests on the assumption that a
// 409 means a concurrent modification and that the authoritative
// ListArchivedSessions distinguishes already-complete (id archived → count done)
// from genuine retryable concurrency (id not archived → retry under budget).
//
// succeededSet + parentOf are the F1 fix: they let classifyArchiveFailure
// recognize a descendant of a root archived by THIS job (see classifyArchiveFailure).
//
// dir is the project dir (reqDir at handleArchive), threaded through to
// classifyArchiveFailure → recordArchiveFailure so the stuck-root record lands
// under the correct (dir,id) composite key (tenant isolation).
func (s *Server) archiveOneID(bgCtx context.Context, agg *aggregator.Aggregator, id string, ts int64, srcID, dir string, cfg archiveRetryConfig, succeededSet map[string]bool, parentOf map[string]string) bool {
	for attempt := 1; attempt <= cfg.budget; attempt++ {
		err := agg.Client().SetArchived(bgCtx, id, ts)
		if err == nil {
			return true // archived
		}
		var ocErr *opencode.Error
		isOCErr := errors.As(err, &ocErr)
		switch {
		case isOCErr && (ocErr.Status == http.StatusNotFound || ocErr.Status == http.StatusGone):
			// Ghost: verifiably gone → archive intent satisfied.
			log.Printf("[archive] SetArchived(%s): %v (session gone — counted complete)", id, err)
			return true
		case isOCErr && ocErr.Status == http.StatusConflict:
			// 409: re-derive from OpenCode's authoritative list. If the id is
			// already archived there, the conflict is benign (concurrent archive
			// won) → count complete. Otherwise fall through to transient retry.
			if idArchivedInOpenCode(bgCtx, agg, id) {
				log.Printf("[archive] SetArchived(%s): 409 but already archived in OpenCode (counted complete)", id)
				return true
			}
			// Not yet archived → transient, retry under budget.
		case isOCErr && (ocErr.Status == http.StatusBadRequest || ocErr.Status == http.StatusForbidden):
			// Permanent client error → no retry will help. Record + classify.
			s.classifyArchiveFailure(agg, dir, id, srcID, fmt.Sprintf("permanent:%d", ocErr.Status), succeededSet, parentOf)
			return false
		default:
			// 401/429/5xx/network/unknown → transient, retry under budget.
		}
		if attempt >= cfg.budget {
			break // exhausted — classify below
		}
		// Transient: exponential backoff + jitter (cancellable via bgCtx).
		select {
		case <-time.After(archiveBackoff(cfg.base, cfg.max, attempt)):
		case <-bgCtx.Done():
			// Shutdown mid-retry: record + return. The id stays live (retained).
			s.classifyArchiveFailure(agg, dir, id, srcID, "cancelled:shutdown", succeededSet, parentOf)
			return false
		}
	}
	// Budget exhausted on a transient error. Classify the stuck id:
	s.classifyArchiveFailure(agg, dir, id, srcID, fmt.Sprintf("exhausted:%d", cfg.budget), succeededSet, parentOf)
	return false
}

// classifyArchiveFailure records a terminal archive failure for id. A DESCENDANT
// of an archived root is the recoverable case: it is left live so the Slice 1/2
// orphan sweep flags it (OrphanBanner surfaces it) — it is NOT recorded as a job
// failure (that would double-count the recovery affordance the banner already
// provides). A ROOT or unresolvable chain is recorded (recordArchiveFailure) so
// the operator has an explicit visibility surface (build-validate 4) and is NEVER
// orphan-flagged (e88f19e gate).
//
// Descendant-of-archived is determined by TWO authorities (F1 fix):
//  1. The authoritative archivedSnapshot (Store.ChainTerminatesAtArchived) — the
//     cross-restart authority Slices 1/2 use. This catches a straggler whose
//     parent was archived by a PRIOR job (or a prior run) and has since entered
//     the snapshot via the periodic reconcile.
//  2. THIS job's succeeded set, walked via the captured parentOf chain. A root
//     archived moments ago by this job is NOT yet in the snapshot, and
//     RemoveSessionIfPresent has already re-rooted the child — so authority 1
//     alone returns false. The succeeded-set walk recognizes the just-orphaned
//     child using the ORIGINAL parent chain captured before any mutation.
func (s *Server) classifyArchiveFailure(agg *aggregator.Aggregator, dir, id, srcID, reason string, succeededSet map[string]bool, parentOf map[string]string) {
	// Authority 1: the authoritative archived snapshot (Slices 1/2).
	if agg.Store().ChainTerminatesAtArchived(id) {
		log.Printf("[archive] SetArchived(%s): %s; descendant of archived root (snapshot) — left live for orphan sweep (Slices 1/2)", id, reason)
		return // the orphan banner surfaces this — do not double-record
	}
	// Authority 2: THIS job's succeeded set via the captured parent chain.
	if descendantOfSucceeded(id, succeededSet, parentOf) {
		log.Printf("[archive] SetArchived(%s): %s; descendant of archived root (this job) — left live for orphan sweep (Slices 1/2)", id, reason)
		return // the orphan banner will surface this once the snapshot reconciles
	}
	s.recordArchiveFailure(dir, id, srcID, reason)
	log.Printf("[archive] SetArchived(%s): %s; root/unresolvable — explicit job failure (not orphan-flagged)", id, reason)
}

// descendantOfSucceeded walks the captured parentOf chain from id upward; if any
// ancestor is in succeededSet, id is a descendant of a root archived by THIS job.
// parentOf was captured at job start (before any RemoveSessionIfPresent mutated
// the tree), so it still links a re-rooted child to its just-archived parent.
// Bounded against cyclic parent links (defensive; malformed data).
func descendantOfSucceeded(id string, succeeded map[string]bool, parentOf map[string]string) bool {
	cur := id
	for i := 0; i < 100; i++ {
		p, ok := parentOf[cur]
		if !ok || p == "" {
			return false // cur is a root in the captured chain
		}
		if succeeded[p] {
			return true
		}
		cur = p
	}
	return false // cycle guard
}

// recordArchiveFailure UPSERTS a stuck-root/unresolvable failure into the
// per-project (dir,id) registry (Slice 1 reshape). A repeat permanent failure
// for the same (dir,id) refreshes Reason/At/RootSrc on ONE coherent record —
// not a duplicate append — so the mobile banner shows one entry per stuck
// root, not a log of every retry. Guards the registry under archiveFailuresMu,
// then fans the updated per-project doc out to live subscribers AFTER releasing
// the lock (no lock held across the emit; the fan-out is in-process, no
// OpenCode HTTP I/O — mirrors sweepOrphansLocked fetch-outside-lock discipline).
func (s *Server) recordArchiveFailure(dir, id, srcID, reason string) {
	s.archiveFailuresMu.Lock()
	s.archiveFailures[archiveFailureKey{Dir: dir, ID: id}] = archiveJobFailure{
		Dir: dir, ID: id, Reason: reason, RootSrc: srcID, At: time.Now(),
	}
	doc := s.archiveFailuresDocForDirLocked(dir)
	s.archiveFailuresMu.Unlock()
	s.fanOutArchiveFailuresUpdate(dir, doc)
}

// clearArchiveFailure removes a resolved failure for (dir,id) — the success-
// funnel counterpart of recordArchiveFailure. Called ONLY at the success
// funnel (runArchiveCascade's `if archiveOneID(...)` block — the chokepoint all
// three success branches fall through), NEVER at the 200-accepted handler
// response (acceptance ≠ success). No-op when no record exists (the happy
// path — first-success on a never-stuck id); the fan-out is GATED on an actual
// deletion so a cascade over N never-stuck ids emits ZERO needless empty-set
// SSE frames (only a lock+lookup+unlock per id). Fans the cleared doc out to
// live subscribers after releasing the lock so every connected client removes
// the warning. The narrow "exhausted + later OOB-delete/archive" ghost-failure
// window (record exists, root later archived outside this daemon) is the
// Slice-2 backstop's job — Slice 1 has no backstop, so a stale warning may
// persist there until daemon restart (bounded + self-healing).
func (s *Server) clearArchiveFailure(dir, id string) {
	s.archiveFailuresMu.Lock()
	key := archiveFailureKey{Dir: dir, ID: id}
	if _, ok := s.archiveFailures[key]; !ok {
		s.archiveFailuresMu.Unlock()
		return // no record → no broadcast (happy path: never-stuck id succeeds)
	}
	delete(s.archiveFailures, key)
	doc := s.archiveFailuresDocForDirLocked(dir)
	s.archiveFailuresMu.Unlock()
	s.fanOutArchiveFailuresUpdate(dir, doc)
}

// ArchiveFailures returns a snapshot copy of ALL recorded archive job failures
// (all projects, sorted by Dir then At then ID for deterministic test output).
// Diagnostic + test surface; the SSE wire path uses archiveFailuresDocForDir
// (per-project, the DTO shape). Existing tests assert only `fl.ID == "x"` and
// are Dir-agnostic, so this keeps working after the registry → map reshape.
// Descendant-of-archived exhausted ids are NOT here — the orphan banner
// surfaces them.
func (s *Server) ArchiveFailures() []archiveJobFailure {
	s.archiveFailuresMu.Lock()
	out := make([]archiveJobFailure, 0, len(s.archiveFailures))
	for _, fl := range s.archiveFailures {
		out = append(out, fl)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir < out[j].Dir
		}
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	s.archiveFailuresMu.Unlock()
	return out
}

// idArchivedInOpenCode re-derives whether id is genuinely archived in OpenCode
// by walking the authoritative archived-session list (the same list
// archivedDescendants consumes). Used by the 409 re-derive path to distinguish
// already-complete (count done) from genuine retryable concurrency. Returns
// false on fetch error (→ retry under budget, never falsely counts complete).
func idArchivedInOpenCode(ctx context.Context, agg *aggregator.Aggregator, id string) bool {
	sessions, err := agg.Client().ListArchivedSessions(ctx)
	if err != nil {
		return false
	}
	for _, raw := range sessions {
		var env struct {
			ID   string `json:"id"`
			Time struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		if env.ID == id && env.Time.Archived != nil && *env.Time.Archived != 0 {
			return true
		}
	}
	return false
}

// archiveBackoff returns the exponential backoff for a transient retry: base *
// 2^(attempt-1), capped at max, with ±20% jitter. attempt is 1-indexed (the
// FIRST retry follows attempt 1's backoff). math/rand/v2 is auto-seeded (Go
// 1.22+), so this is nondeterministic by design — tests shrink base/max so the
// jitter is immaterial to timing assertions.
func archiveBackoff(base, max time.Duration, attempt int) time.Duration {
	d := base
	for i := 1; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	// Jitter ±20% of d: offset ∈ [-d/5, +d/5].
	halfRange := int64(d) / 5
	if halfRange > 0 {
		offset := rand.Int64N(halfRange*2+1) - halfRange
		d += time.Duration(offset)
	}
	return d
}

// reassertArchiveWork is the post-archive re-assert body (Issue A), refactored
// out of the prior standalone reassertArchive so the cascade job (which owns the
// single bgWG Done) can call it inline after archiving the succeeded set. The
// prior dispatcher is retired (runArchiveCascade subsumes it); this body retains
// its delay wait, test seams (reassertReadyCh/reassertBlockCh), and the
// re-list + re-PATCH loop unchanged.
//
// The delay wait is a cancellable select on bgCtx.Done() (not a bare
// time.Sleep): if Shutdown runs during the delay window, the goroutine exits
// promptly. The RPC context is a timeout child of bgCtx, so the same Shutdown
// cancellation propagates to an in-flight ListSessions/SetArchived.
func (s *Server) reassertArchiveWork(bgCtx context.Context, delay time.Duration, agg *aggregator.Aggregator, affected []string, srcID string) {
	select {
	case <-time.After(delay):
	case <-bgCtx.Done():
		return
	}
	// Test-only seam (Issue A ownership test; nil in production). Signal
	// readiness, then optionally block on a pure (ctx-independent) channel
	// receive. Everything else this goroutine does is ctx-bound, so bgCancel
	// frees it immediately — which makes Shutdown's bgWG.Wait unobservable via
	// timing. The pure block here is the one spot bgCancel CANNOT reach, so a
	// test can hold the job and prove the ONLY way Shutdown returns is by
	// awaiting bgWG (cancel alone leaves it blocked here). Guarded by bgMu for
	// the one-shot close of reassertReadyCh.
	s.bgMu.Lock()
	ready := s.reassertReadyCh
	block := s.reassertBlockCh
	if ready != nil {
		select {
		case <-ready:
		default:
			close(ready)
		}
	}
	s.bgMu.Unlock()
	if block != nil {
		<-block
	}
	ctx, cancel := context.WithTimeout(bgCtx, 10*time.Second)
	defer cancel()
	sessions, err := agg.Client().ListSessions(ctx)
	if err != nil {
		log.Printf("[archive] re-assert ListSessions(%s): %v", srcID, err)
		return
	}
	// Build the set of ids OpenCode reports as genuinely archived
	// (time.archived set to a non-zero value). Mirrors
	// sessionEnvelope.archivedAt() in pkg/state/store.go.
	archivePersisted := make(map[string]bool, len(sessions))
	for _, raw := range sessions {
		var env struct {
			ID   string `json:"id"`
			Time struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		if env.Time.Archived != nil && *env.Time.Archived != 0 {
			archivePersisted[env.ID] = true
		}
	}
	ts := time.Now().UnixMilli()
	for _, id := range affected {
		if archivePersisted[id] {
			continue // archive persisted for this id
		}
		// Don't re-PATCH if the tombstone is gone — either the TTL
		// expired (archive is long-settled, OpenCode is consistent) or the id
		// was explicitly unarchived (ClearArchiveTombstones). Re-PATCHing in
		// that window would undo a legitimate unarchive. The tombstone is the
		// re-assert's signal that the archive intent still holds (re-assert
		// fires at the captured delay, well inside recentArchiveTTL).
		if !agg.Store().IsRecentlyArchived(id) {
			continue
		}
		if err := agg.Client().SetArchived(ctx, id, ts); err != nil {
			log.Printf("[archive] re-assert SetArchived(%s): %v", id, err)
		}
	}
}

// resumeArchiveAffected derives the affected set for the RT4 resume path: when
// handleArchive is invoked for a root that is ABSENT from the live store
// (Store.Descendants returned nil — the root was archived by a prior cascade and
// RemoveSessionIfPresent removed it, or it was pruned by hydrate/demotion), the
// live-store subtree walk can't see its remaining descendants. This method
// fetches OpenCode's authoritative session lists and, if the root is confirmed
// archived, derives the set of LIVE (non-archived) sessions still in its subtree
// — the stragglers a reissue must complete (the contract RT4: "re-issuing
// archive on a partially-archived root completes the remainder").
//
// Returns [rootID] (the prior ghost-tolerant fallback) when:
//   - either fetch fails (never inflate a partial view into a wrong affected
//     set — the root alone is re-PATCH'd / 404-tolerated),
//   - the root is NOT confirmed archived in OpenCode (genuinely absent / ghost /
//     never-existed — the prior fallback), or
//   - the root IS archived but has NO live stragglers (fully-archived idempotent
//     no-op — re-PATCH the root, same as the prior fallback; the existing
//     TestQueueGC_ReissueArchiveIsIdempotent covers this path).
//
// Fetch authority (build-validate 1): BOTH lists are required. The VERIFIED
// OpenCode behavior (pkg/fixtures/opencode.go:929-937, confirmed by Slice 1's
// hydration.go:132-135 comment "The /session list excludes archived entries") is
// that /session returns LIVE-only and /session?archived=true returns ARCHIVED-
// only. A live straggler's parent chain may pass through ARCHIVED intermediates
// (a partial cascade that aborted at a deep child); the live list alone lacks
// those intermediates' parentIDs to link the straggler to the root. The archived
// list supplies the intermediate parentID links so the DFS reaches the live
// leaves through any depth of archived ancestors.
//
// Lock discipline (build-validate 2): the OpenCode fetches happen OUTSIDE the
// store lock (the aggregator Client is HTTP). The only store access in
// handleArchive (Descendants) already completed under a brief RLock before this
// is called; no store lock is held across the fetch. This is NOT the hot path —
// normal archive uses the live-store Descendants walk; this fires only on the
// reissue/ghost edge case (root absent from the live store).
func (s *Server) resumeArchiveAffected(ctx context.Context, agg *aggregator.Aggregator, rootID string) []string {
	live, errLive := agg.Client().ListSessions(ctx)
	archived, errArch := agg.Client().ListArchivedSessions(ctx)
	if errLive != nil || errArch != nil {
		// Fetch failed — can't safely derive. Fall back to the prior ghost-
		// tolerant behavior (re-PATCH / 404-tolerate the root alone).
		return []string{rootID}
	}
	if !idHasArchivedTime(archived, rootID) {
		// Root is not confirmed archived in OpenCode (ghost / never-existed / or
		// live-but-absent-from-our-store). Fall back to [rootID]: the job will
		// PATCH it (archives if genuinely live) or 404/410-tolerate (ghost).
		return []string{rootID}
	}
	stragglers := liveDescendantsOfArchivedRoot(live, archived, rootID)
	if len(stragglers) == 0 {
		// Root is archived but no live stragglers remain — fully-archived no-op.
		// Re-PATCH the root idempotently (same as the prior fallback).
		return []string{rootID}
	}
	return stragglers
}

// idHasArchivedTime reports whether id is present in sessions with a non-zero
// time.archived (genuinely archived). Mirrors sessionEnvelope.archivedAt() in
// pkg/state/store.go. Used by resumeArchiveAffected to confirm a root is
// archived in OpenCode's authoritative list before deriving live stragglers.
func idHasArchivedTime(sessions []json.RawMessage, id string) bool {
	for _, raw := range sessions {
		var env struct {
			ID   string `json:"id"`
			Time struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID != id {
			continue
		}
		return env.Time.Archived != nil && *env.Time.Archived != 0
	}
	return false
}

// liveDescendantsOfArchivedRoot returns the set of currently-LIVE (non-archived)
// sessions in rootID's subtree, derived from OpenCode's authoritative session
// lists. It is the RT4 resume derivation: when a root is already archived
// (absent from the live store), this reconstructs its subtree from OpenCode and
// collects the live stragglers a reissue must complete.
//
// BOTH the live and archived lists are required (see resumeArchiveAffected's
// "Fetch authority" note): the live list holds the stragglers but lacks the
// parentID links of archived intermediates; the archived list supplies those
// links so the DFS reaches live leaves through any depth of archived ancestors.
//
// Only ids with time.archived == 0 (genuinely live) are collected — rootID
// itself (archived) and any archived intermediates are TRAVERSED (so a deeper
// live member stays reachable) but never collected. This preserves the e88f19e
// false-positive gate: only confirmed-subtree LIVE descendants are returned,
// never an unrelated live session. The DFS starts at rootID and follows
// parent→child edges through the unified children map, so an unrelated root's
// subtree is structurally unreachable (exact-parent confirmation).
func liveDescendantsOfArchivedRoot(live, archived []json.RawMessage, rootID string) []string {
	// Build a unified parent→children map and a live-id set from BOTH lists.
	// Iterating both lets the DFS traverse archived intermediates (which appear
	// only in `archived`) to reach live stragglers (which appear only in `live`).
	children := map[string][]string{}
	isLive := map[string]bool{}
	for _, sessions := range [][]json.RawMessage{live, archived} {
		for _, raw := range sessions {
			var env struct {
				ID       string `json:"id"`
				ParentID string `json:"parentID"`
				Time     struct {
					Archived *float64 `json:"archived"`
				} `json:"time"`
			}
			if json.Unmarshal(raw, &env) != nil || env.ID == "" {
				continue
			}
			if env.ParentID != "" {
				children[env.ParentID] = append(children[env.ParentID], env.ID)
			}
			// A genuinely live session (time.archived absent or zero). Track it
			// so the walk collects it; archived members are traversed (linked)
			// but skipped at collection. Mirrors sessionEnvelope.archivedAt().
			if env.Time.Archived == nil || *env.Time.Archived == 0 {
				isLive[env.ID] = true
			}
		}
	}
	// DFS from rootID through the unified children map. Collect only LIVE ids
	// (the stragglers to archive). rootID itself is archived → never collected
	// (the cur != rootID gate). seen guards against a revisit loop on malformed
	// parent links (defensive; session trees are acyclic but never trust data).
	out := []string{}
	seen := map[string]bool{}
	stack := []string{rootID}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if cur != rootID && isLive[cur] {
			out = append(out, cur)
		}
		stack = append(stack, children[cur]...)
	}
	return out
}

// archivedDescendants returns id plus every genuinely archived session
// transitively parented by it, so that re-clicking Restore (unarchive) on id
// retries any member of its subtree that is still archived — including the
// case where id itself already unarchived (a partial-batch failure can leave a
// child archived after its parent succeeded).
//
// The input list is OpenCode's archived-set response, but 1.17.x ignores
// ?archived=true and returns ALL sessions (archived + active). The subtree
// traversal is therefore built from ALL of them — so the parent→child link to
// a still-archived child survives even after the root leaves the archived set
// — and only the still-archived members (plus the root itself, as an idempotent
// no-op re-write) are collected for unarchive. A non-archived descendant is
// traversed (so a deeper archived member stays reachable) but is never folded
// into the result (it is already active). See the "Batch semantics" section of
// docs/architecture/opencode-sqlite-unarchive.md.
func archivedDescendants(sessions []json.RawMessage, id string) []string {
	// Build the parent→children map from ALL sessions (active + archived) so
	// the subtree stays reachable for retry even after the root unarchives — a
	// partial-batch failure can leave a child archived while its parent is
	// already active, and that child must remain reachable through it. Track
	// which members are genuinely archived so the collected set stays minimal.
	children := map[string][]string{}
	archived := map[string]bool{}
	for _, raw := range sessions {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
			Time     struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		if env.ParentID != "" {
			children[env.ParentID] = append(children[env.ParentID], env.ID)
		}
		// OpenCode 1.17.x ignores the ?archived=true param and returns ALL
		// sessions (archived + non-archived). Track only genuinely archived
		// members (time.archived set to a non-zero value) so non-archived
		// descendants are traversed but never collected. Mirrors
		// sessionEnvelope.archivedAt() in pkg/state/store.go.
		if env.Time.Archived != nil && *env.Time.Archived != 0 {
			archived[env.ID] = true
		}
	}
	// Walk the full subtree rooted at id. Collect id itself (an idempotent
	// no-op re-write if it is already active) plus every still-archived member.
	// This is what makes a retry complete the batch: a child left archived by a
	// partial failure remains reachable through its now-active parent. seen
	// guards against a revisit loop on malformed parent links.
	out := []string{}
	seen := map[string]bool{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if cur == id || archived[cur] {
			out = append(out, cur)
		}
		stack = append(stack, children[cur]...)
	}
	return out
}

// POST /vh/reload — rebuild the server's view from OpenCode (the source of
// truth) without restarting the process or the running OpenCode. Clients
// converge via the reconciled upsert/delete events.
func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.aggFor(reqDir(r)).Rehydrate(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// POST /vh/reload-project — evict ONE project's cached OpenCode instance and
// drop this daemon's aggregator for it, so the NEXT access rebuilds both fresh
// from disk (picking up config edits) WITHOUT the fleet-wide `opencode serve`
// restart and WITHOUT disturbing other projects (including the default). The
// user-facing label is "Reload project"; the upstream route this drives is
// POST /instance/dispose (see pkg/opencode Client.Dispose).
//
// Sequence:
//  1. Dispose the OpenCode instance cache for dir (in-flight turns finish on
//     the old instance; the next request rebuilds Config.node fresh).
//  2. For a NON-default dir (dir != ""): stop the per-dir permission-reconcile
//     sweep (stopPermissionWatcher), tear this daemon's aggregator down
//     (a.Stop cancels its Run + closes its store's SSE subscribers) and drop it
//     from s.aggs so the next aggFor builds a fresh one. Guarded against a
//     double-dispose race by re-checking s.aggs[dir]==a under aggMu.
//  3. For the DEFAULT dir (dir == ""): dispose only — the default aggregator is
//     process-lifetime (held by s.agg and started outside aggFor, so a.cancel is
//     nil); tearing it down would leave s.agg dangling. The default permission
//     sweep is likewise process-lifetime (never stopped by Reload). The OpenCode
//     instance rebuild still applies config edits on the next request.
func (s *Server) handleReloadProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dir := reqDir(r)

	// Resolve the per-project client so Dispose carries the right
	// x-opencode-directory header. For a dir we already have an aggregator for,
	// reuse its client; otherwise build a throwaway client scoped to dir (the
	// default — dir == "" — falls back to OpenCode's process cwd). The default
	// aggregator is stored under both s.agg and s.aggs[""], so dir == "" resolves
	// to it directly.
	s.aggMu.Lock()
	a, ok := s.aggs[dir]
	s.aggMu.Unlock()
	var client *opencode.Client
	if ok {
		client = a.Client()
	} else {
		client = opencode.New(s.opencodeURL)
		client.Directory = dir
	}
	if err := client.Dispose(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Teardown is for NON-default projects only (see method doc). For dir == ""
	// the default aggregator is process-lifetime and must stay.
	if dir != "" && ok {
		s.aggMu.Lock()
		// Re-check under the lock: a concurrent reload for the same dir may have
		// already swapped the aggregator (T1 deleted `a`, a later aggFor built
		// `a2` and armed ITS watcher). Only stop the watcher + Stop+delete the
		// exact aggregator we disposed, so a stale request never disarms a2's
		// freshly-armed sweep. stopPermissionWatcher nests watcherMu INSIDE
		// aggMu — the same order aggFor already establishes via its
		// ensurePermissionWatcher call.
		if cur := s.aggs[dir]; cur == a {
			s.stopPermissionWatcher(dir)
			a.Stop()
			delete(s.aggs, dir)
			// Reset queueGCOn so the next aggFor(dir) rebuilds the queue-GC
			// subscriber on the new aggregator's store. Lock order matches
			// stopPermissionWatcher: queueGCMu nested inside aggMu.
			s.queueGCMu.Lock()
			delete(s.queueGCOn, dir)
			s.queueGCMu.Unlock()
			// Reset pinsGCOn for the same reason: the next aggFor(dir) builds a
			// FRESH aggregator (new store, new subs map), and the L2 pins
			// subscriber must be rebuilt on it. Mirrors the queueGCOn reset
			// above; pinsGCMu nested inside aggMu (same lock order).
			s.pinsGCMu.Lock()
			delete(s.pinsGCOn, dir)
			s.pinsGCMu.Unlock()
			// Reset labelsGCOn for the same reason: the next aggFor(dir) builds a
			// FRESH aggregator (new store, new subs map), and the labels L2
			// subscriber must be rebuilt on it. Mirrors the pinsGCOn reset above;
			// labelsGCMu nested inside aggMu (same lock order).
			s.labelsGCMu.Lock()
			delete(s.labelsGCOn, dir)
			s.labelsGCMu.Unlock()
		}
		s.aggMu.Unlock()
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// POST /vh/restart-server — restart the vh daemon itself (re-exec, or exit for a
// supervisor to relaunch). Responds first, then triggers the restart; the client
// reconnects automatically. OpenCode survives only in detached/external mode.
func (s *Server) handleRestartServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.restartServer == nil {
		http.Error(w, "server restart is not available here", http.StatusNotImplemented)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	// Restart after the response is on the wire.
	go func() {
		time.Sleep(250 * time.Millisecond)
		s.restartServer()
	}()
}

// POST /vh/restart-opencode — restart the managed OpenCode process (interrupts
// any in-flight turn; sessions persist in OpenCode's store). The aggregator
// reconnects and re-hydrates automatically once OpenCode is back up.
func (s *Server) handleRestartOpenCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.restartOC == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	if err := s.restartOC(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// GET /vh/archived?parent=&offset=&limit= — one level of the archived tree,
// sourced live from OpenCode (GET /session?archived=true). Returns the sessions
// at that level plus child counts so the client can show expand affordances and
// page through without loading everything.
func (s *Server) handleArchived(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parent := q.Get("parent")
	offset, _ := strconv.Atoi(q.Get("offset"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	sessions, err := s.aggFor(reqDir(r)).Client().ListArchivedSessions(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	items, total, counts := archivedLevel(sessions, parent, offset, limit)
	writeJSONResp(w, map[string]any{
		"sessions":    items,
		"childCounts": counts,
		"total":       total,
		"offset":      offset,
		"limit":       limit,
	})
}

// archivedLevel slices one level of the archived tree from a flat archived list:
// the children of `parent` (or the archived roots — whose parent is not itself
// archived — when parent is ""), newest first, paginated, plus the archived
// child counts for the returned sessions.
func archivedLevel(sessions []json.RawMessage, parent string, offset, limit int) ([]json.RawMessage, int, map[string]int) {
	type meta struct {
		id, parentID string
		updated      float64
		info         json.RawMessage
	}
	all := make([]meta, 0, len(sessions))
	archivedID := map[string]bool{}
	for _, raw := range sessions {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
			Time     struct {
				Updated  float64  `json:"updated"`
				Created  float64  `json:"created"`
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		// OpenCode 1.17.x ignores the ?archived=true param and returns ALL
		// sessions (archived + non-archived). Filter server-side here: only a
		// genuinely archived session (time.archived set to a non-zero value)
		// belongs in the browser. Mirrors sessionEnvelope.archivedAt() in
		// pkg/state/store.go.
		if env.Time.Archived == nil || *env.Time.Archived == 0 {
			continue
		}
		archivedID[env.ID] = true
		u := env.Time.Updated
		if u == 0 {
			u = env.Time.Created
		}
		all = append(all, meta{id: env.ID, parentID: env.ParentID, updated: u, info: raw})
	}

	// Child counts (within the archived set) for every node.
	counts := map[string]int{}
	for _, m := range all {
		if m.parentID != "" && archivedID[m.parentID] {
			counts[m.parentID]++
		}
	}

	var level []meta
	for _, m := range all {
		isRoot := m.parentID == "" || !archivedID[m.parentID]
		if (parent == "" && isRoot) || (parent != "" && m.parentID == parent) {
			level = append(level, m)
		}
	}
	sort.Slice(level, func(a, b int) bool { return level[a].updated > level[b].updated })

	total := len(level)
	if offset > total {
		offset = total
	}
	end := total
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	items := make([]json.RawMessage, 0, end-offset)
	levelCounts := map[string]int{}
	for _, m := range level[offset:end] {
		items = append(items, m.info)
		if c := counts[m.id]; c > 0 {
			levelCounts[m.id] = c
		}
	}
	return items, total, levelCounts
}
