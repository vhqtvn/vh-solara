// Commands that mutate sessions or the workspace: selection, project switch,
// draft/create lifecycle, and the server round-trips (permission/question reply,
// abort). These call into the stream (connect) and url (syncUrl) but nothing
// calls back into them, so they sit at the top of the sync dependency graph
// (below only the barrel that wires startup).
import { produce } from "solid-js/store";
import { setView } from "../ui";
import { saveVersioned } from "../lib/store";
import { log } from "../lib/log";
import {
  state,
  setState,
  projectDir,
  selectedId,
  setProjectDirRaw,
  setSelectedIdRaw,
  setDraft,
  loadActivity,
  loadLastAgents,
  loadSessionAgents,
  resetSessionAgentPicks,
  loadSessionModels,
  resetSessionModelPicks,
  loadCursor,
  persistSelection,
  LS_PROJECT,
} from "./store";
import { syncUrl } from "./url";
import { connect } from "./tree-transport";
import { closeSessionStream } from "./session-stream";
import { resetPageInFlight } from "./history";
import { resetTreeStore, clearUserToggled, applyTreeOpStore } from "./treeState";
import { resetLabelsScope } from "../labels";
import { resetArchiveFailuresScope } from "../archiveFailures";
import { ackSession } from "./orchestration";
import { pushNotification } from "../notify";
import { beginDraftGeneration, detectCreateSupport, modernCreateSession } from "../lib/sessionCreateStatus";
import { markOwnerSessionCreateRejected } from "../lib/sendActionStatus";

// Selecting any real session leaves draft mode.
//
// userToggled clear: the transient twisty-click overlay is cleared SYNCHRONOUSLY
// here, but ONLY when the id actually changes. This avoids the race where a
// twisty click (which does NOT change selection) would lose its overlay before
// the persisted mode change lands. A real selection change (different id) resets
// the overlay so the new selection's ancestor chain re-evaluates temp from
// scratch; a same-id re-select (re-clicking the open session to jump back to
// chat) leaves the overlay intact. Done in the setter, NOT a delayed effect, so
// persisted mode changes from a just-prior twisty click survive the clear.
export function setSelectedId(id: string | null) {
  if (id !== selectedId()) clearUserToggled();
  if (id) setDraft(false);
  setSelectedIdRaw(id);
  syncUrl(id);
  // ACK-ON-SELECT (tab-pairs slice, cross-device unread sync): selecting a
  // session acks it server-side (POST /vh/ack → the root's finished-unread
  // watermark clears → every device's aggregate drops). This funnel is the ONE
  // selection chokepoint — tree clicks, CommandPalette, NotificationCenter,
  // ToolPart jumps, archive restores, and the host shell's reverse-nav
  // (vh-host-select → selectListener → setSelectedId) all land here, so
  // embedded mode is covered by construction. Before this, the ack fired only
  // on bottom-reached/open-at-bottom scroll gestures, which left a gap: a
  // session with a stored mid-history read anchor did NOT ack on selection, so
  // another device's (X|Y) kept showing a stale unread count. ackSession
  // resolves the ROOT internally (subsession selects ack the root watermark)
  // and early-returns when nothing is armed, so this is a no-op for
  // non-unread selections. The anchor/scroll machinery is untouched — the read
  // CURSOR still restores mid-history; only the unread watermark semantics
  // changed (selection = read).
  if (id) ackSession(id);
  // Persist the selection per-project so an OS-driven PWA relaunch (which
  // drops ?session=) restores it. switchProject/newSession bypass this via
  // setSelectedIdRaw (they clear, not select), so a project switch never
  // clobbers the incoming project's saved id with null.
  persistSelection(projectDir(), id);
}

// Switch the active project directory: reset state and reconnect the stream
// scoped to it. `fromUrl` is set by popstate (don't re-push history). The dir is
// mirrored to both localStorage (fallback) and the URL (source of truth,
// per-tab). `dir === ""` lands the app on the no-project empty state: the
// daemon's cwd is not a meaningful project, so we close the streams and clear
// per-project state instead of bridging cwd.
export function switchProject(dir: string, fromUrl = false) {
  if (dir === projectDir()) return;
  saveVersioned(LS_PROJECT, 1, dir);
  setProjectDirRaw(dir);
  setSelectedIdRaw(null);
  setDraft(false);
  if (!fromUrl) syncUrl(null);
  // Phase 4: clear all in-flight historical-page requests on project switch.
  // A page in flight belongs to the outgoing project's session; it must not
  // land into the new project's session (id-reuse across projects is possible).
  // Mirrors the messageWindows={} reset below.
  resetPageInFlight();
  setState(
    produce((s) => {
      // §11: sessions are NOT persisted to localStorage (caused flatten-on-load).
      // Start empty; the server snapshot repopulates via connect(true) below.
      s.sessions = {};
      s.messages = {};
      // Phase 3: clear the per-session bounded-window map alongside the other
      // per-session maps (messagesDelivered/messagesError). A previous project's
      // window state (hasOlder / oldestResidentID) must not leak across the
      // switch — the new project's snapshot repopulates it from scratch.
      s.messageWindows = {};
      s.messagesDelivered = {};
      s.messagesError = {};
      s.activity = loadActivity(dir);
      // B2b audit: lastAgents is a per-session facet that must NOT carry over
      // from the previous project (orphan-map gap). Like activity, it is
      // per-project persisted, so hydrate the new project's chips instantly and
      // let the live snapshot reconcile. Without this, a switched-away project's
      // agent labels lingered until the first snapshot landed.
      s.lastAgents = loadLastAgents(dir);
      s.permissions = {};
      s.questions = {};
      s.unread = {};
      // Phase 3 snapshot trim: clear the hoisted project constants so a stale
      // fallback from the outgoing project doesn't linger before the new
      // project's first projected snapshot repopulates it.
      s.projectConstants = undefined;
      s.cursor = loadCursor(dir);
      s.status = "connecting";
    }),
  );
  // Project switch: re-seed the persisted per-session agent picks from the
  // NEW project dir's localStorage (mirrors the lastAgents/activity re-seeds
  // above — the picks map is per-project and must not leak across the switch).
  // resetSessionAgentPicks only swaps memory; the new dir already owns its
  // persisted copy.
  resetSessionAgentPicks(loadSessionAgents(dir));
  // Same re-seed for the per-session MODEL picks (P1): the map is per-project
  // keyed by dir; without this, the outgoing project's picks would leak into
  // the incoming project's composer resolution (and an id shared across
  // projects would resolve the wrong pick). resetSessionModelPicks only swaps
  // memory; the new dir already owns its persisted copy.
  resetSessionModelPicks(loadSessionModels(dir));
  // Project switch clears the tree (flat map + in-memory userExpanded). A
  // same-project resync does NOT clear — connect(true) swaps the snapshot
  // atomically (seedTreeStore) and preserves userExpanded; only a true project
  // switch discards the outgoing project's tree. This sits BEFORE the if(!dir)
  // split so BOTH the no-dir teardown and the project-switch reconnect clear.
  resetTreeStore();
  // Per-project labels (commit 23efd32): each project has its own labels
  // revision/CAS domain + its own labels.snapshot bootstrap. Clear the outgoing
  // project's labels IMMEDIATELY — before connect() opens the incoming project's
  // stream — so A's labels are gone before B connects, and so any in-flight PUT
  // from A is invalidated (resetLabelsScope bumps labelsScopeGen; performMutation
  // drops the late response). Sits alongside resetTreeStore so both the no-dir
  // teardown and the switch reconnect clear, mirroring the session/tree resets.
  resetLabelsScope();
  // Per-project archive-failures (archive-failure-visibility feature): each
  // project has its own stuck-root registry + its own archive-failures.snapshot
  // bootstrap. Clear the outgoing project's failures IMMEDIATELY — before
  // connect() opens the incoming project's stream — so A's stuck-root banner is
  // gone before B connects. Without this, a no-project switch ('') renders A's
  // banner INDEFINITELY (connect early-returns on empty dir → no snapshot), and
  // an A→B switch leaks A's failures into B's banner until B's snapshot lands.
  // resetArchiveFailuresScope also bumps archiveFailuresScopeGen so any in-flight
  // frame from A is dropped on arrival (defense-in-depth; the primary guard is
  // treeGen at the transport listener). Mirrors resetLabelsScope precisely.
  resetArchiveFailuresScope();
  if (!dir) {
    // No-project state: tear down both streams so nothing keeps bridging the old
    // project (or cwd). connect() would no-op too, but closing the session
    // stream explicitly is required (connect only owns the tree stream). Leave
    // status as "connecting"; the no-project view hides the session tree, so the
    // status dot is not in a misleading state for the user's current focus.
    closeSessionStream();
    connect(true); // early-returns on empty dir but closes the tree stream
    return;
  }
  connect(true); // project switch: snapshot to fully reconcile the new project's state
}

// Reserve a session's message slot so the chat renders immediately; the actual
// history + live updates come from the active-session message stream (Stream 2),
// which is the sole owner of message state to avoid a one-shot fetch clobbering
// in-flight streamed deltas.
export async function openSession(id: string) {
  // Mark not-delivered only when actually reserving a fresh slot. A reopening
  // session keeps its cached messages (and its delivered=true) so it renders
  // instantly instead of flashing a loading state. See SyncState.messagesDelivered.
  if (!state.messages[id]) {
    setState("messages", id, { order: [], byId: {} });
    setState("messagesDelivered", id, false);
  }
}

// "New session" no longer hits the server — it enters draft mode so an unused,
// empty session is never created. The real session is created on first send.
export function newSession() {
  // Create-certainty Slice 2 (§3.2 identity): a new explicitly independent
  // draft is a new draft GENERATION — the previous create operation (whatever
  // its state) stops being this draft's operation and stays behind as honest
  // unresolved metadata; the next send mints a fresh idempotency key.
  beginDraftGeneration(projectDir());
  setSelectedIdRaw(null);
  setDraft(true);
  syncUrl(null);
  setView("chat"); // composing always happens in the chat view
}

// Bounded timeout for the createSession POST (the stuck-send bug class — same
// precedent as queue.ts ENQUEUE_TIMEOUT_MS / code/api.ts timedFetch): a hung
// socket used to leave runSendSingleFlight("draft") pending forever, so the
// draft Send button pulsed (the glow) and stayed disabled until a page reload.
// On abort the existing catch returns null and send() restores the composer
// text for retry — no silent loss.
const CREATE_SESSION_TIMEOUT_MS = 12000;

// Typed createSession outcome (send-reliability slice 2). A null id alone no
// longer carries enough information: /oc/session is the PROXY route, and a
// proxy 502 (transport failure, pkg/web/server.go) or a timeout/response loss
// does NOT prove the session was not created. `certainty` distinguishes:
//   definitive — the server answered definitively (non-502 error status, or a
//                malformed 2xx): the session was NOT created.
//   unknown    — timeout / network failure / proxy 502: the session MAY exist;
//                a re-send may create a SECOND session (the caller must tell
//                the operator to check first — the LEGACY path has no
//                idempotency key; the modern /vh/session/create protocol
//                (create-certainty Slice 2) recovers via receipt lookup only).
export type CreateSessionOutcome = {
  id: string | null;
  certainty: "definitive" | "unknown";
  detail?: string;
  // Create-certainty Slice 2: true when NO create POST was sent because the
  // capability check came back uncertain (the safety ladder) — a RETRY-SAFE
  // failure that must never be presented as session-created-unknown.
  capabilityUnavailable?: boolean;
  // A1 create-linkage (send-defers study): CLIENT clock (ms) at the moment the
  // create POST was armed — the START of the create-attempt window. On an
  // outcome-unknown result, ChatView.ensureSession hands this to
  // markOwnerSessionCreateUnknown so the record carries [startedAt, markTime]
  // and SendStatus's operator-confirmed linkage affordance can correlate a
  // session whose time.created (worker clock) lands inside it.
  startedAt: number;
};

// Create a session on the server (called when the draft's first message is
// sent). Returns the new id, or null on failure.
//
// Legacy thin wrapper over createSessionWithCertainty (same contract as before
// the slice: id or null) for callers that do not consume certainty.
export async function createSession(): Promise<string | null> {
  return (await createSessionWithCertainty()).id;
}

// The certainty-carrying variant ChatView.ensureSession uses.
//
// Create-certainty Slice 2 — the capability ladder runs BEFORE any POST:
//   modern  → lib/sessionCreateStatus.modernCreateSession (idempotency key,
//             receipt recovery, operation-scoped transfer);
//   legacy  → the unchanged /oc/session flow below (today's behavior);
//   uncertain → NO create POST may be sent (neither route): a retry-safe
//             definitive failure, never session-created-unknown.
//
// NAVIGATION NOTE (§3.3): neither branch navigates anymore. The low-level
// create action answers with the receipt; createSend applies ownership first
// (modern: operation-scoped transfer; legacy: the broad draft sweep) and THEN
// materializes the session (materializeSession: setSelectedId + openSession)
// before the admission tail — receipt/ownership before navigation, at most
// one navigation per uninterrupted send.
export async function createSessionWithCertainty(): Promise<CreateSessionOutcome> {
  const startedAt = Date.now();
  const support = await detectCreateSupport();
  if (support === "modern") return modernCreateSession(startedAt);
  if (support === "legacy") return legacyCreateSession(startedAt);
  // Capability UNCERTAIN (401/403/auth-redirect/arbitrary HTML/malformed
  // JSON/wrong version/502/network/timeout): nothing was sent on EITHER
  // route — retry is safe, and the record must not claim create-unknown
  // (no duplicate risk exists). Pre-mark the preparing record with the
  // capability-specific reason; createSend's generic failure mark defers to
  // an already-terminal record.
  markOwnerSessionCreateRejected(
    "draft",
    "session-create capability check unavailable (nothing was sent)",
    "capability-unavailable",
  );
  return {
    id: null,
    certainty: "definitive",
    detail: "session-create capability check unavailable (nothing was sent; safe to retry)",
    capabilityUnavailable: true,
    startedAt,
  };
}

// The LEGACY /oc/session flow, byte-compatible with the pre-Slice-2 behavior
// (same classification, same 12s bound) except that it no longer navigates —
// see createSessionWithCertainty's navigation note.
async function legacyCreateSession(startedAt: number): Promise<CreateSessionOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CREATE_SESSION_TIMEOUT_MS);
  try {
    const res = await fetch("/oc/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // NOTE: body already read inside the armed window shape-wise is not
      // needed here — the classification only needs the status. A 502 from
      // the catch-all proxy is a TRANSPORT failure (the POST may have been
      // applied upstream): outcome unknown. Any other status is a definitive
      // server answer: not created.
      if (res.status === 502) {
        return { id: null, certainty: "unknown", detail: `proxy 502 creating session`, startedAt };
      }
      return { id: null, certainty: "definitive", detail: `HTTP ${res.status} creating session`, startedAt };
    }
    const sess = await res.json();
    if (sess?.id) {
      return { id: sess.id, certainty: "definitive", startedAt };
    }
    return { id: null, certainty: "definitive", detail: "session create response had no id", startedAt };
  } catch (e) {
    // Network error OR abort/timeout — no response confirmed either way: the
    // session may have been created. Outcome unknown, never "not created".
    const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    return {
      id: null,
      certainty: "unknown",
      detail: aborted ? "session create timed out" : `session create request failed (${String(e)})`,
      startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded timeout for the small JSON POSTs that carry turn input and recovery
// actions (permission/question replies, /vh/abort) — send-reliability hygiene
// micro-slice (§8 item 6b): a hung socket on the canonical permission reply
// left the legacy fallback unreachable and the reply silently never landed
// while the card was already optimistically cleared (turn stuck pending
// input). All four are tiny request/response round-trips on the order of
// milliseconds; 10s is a very generous bound. Mirrors the
// CREATE_SESSION_TIMEOUT_MS AbortController precedent above.
const REPLY_TIMEOUT_MS = 10000;

// Typed outcome of a bounded POST (see postBounded). `kind` distinguishes the
// outcomes callers must not conflate:
//   ok       — a 2xx arrived.
//   status   — a definitive non-2xx answer arrived (carries the status).
//   timeout  — NO response within the bound: the outcome is UNKNOWN (the POST
//              may have been applied upstream) — callers must NOT claim
//              "failed" nor blindly re-issue an input-carrying reply.
//   network  — the request failed without a response (may also have been
//              applied). Kept distinct from timeout so legacy fallback
//              behavior (fire on a network error) is preserved unchanged.
type BoundedPostResult =
  | { kind: "ok" }
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "network"; error: unknown };

// postBounded POSTs JSON with an armed AbortController and NEVER throws — a
// hung socket settles to `{ kind: "timeout" }` instead of a pending-forever
// promise, and a network failure to `{ kind: "network" }`.
async function postBounded(url: string, body: unknown, timeoutMs = REPLY_TIMEOUT_MS): Promise<BoundedPostResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res.ok ? { kind: "ok" } : { kind: "status", status: res.status };
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    return aborted ? { kind: "timeout" } : { kind: "network", error: e };
  } finally {
    clearTimeout(timer);
  }
}

// Surface a timed-out permission/question reply honestly (send-reliability
// hygiene micro-slice). SEMANTICS: a timed-out reply is OUTCOME-UNKNOWN — the
// POST may have been applied upstream, so this must NOT claim "failed", and
// the card must NOT be restored as if unsent (a restored card invites a
// SECOND reply for a request that may already be answered). The minimal
// honest surface is one notification with outcome-unknown wording; the card
// stays cleared and later server events reconcile the turn's real state.
function replyOutcomeUnknown(kind: "Permission" | "Question", sessionID?: string): void {
  pushNotification({
    kind: "error",
    sessionID,
    title: `${kind} reply not confirmed`,
    detail:
      `The ${kind.toLowerCase()} reply was sent but no confirmation arrived — ` +
      "it may still have been applied. The card was not restored; check the " +
      "session's state before answering again.",
  });
}

// Reply to a pending permission request: "once" | "always" | "reject".
// Uses OpenCode's canonical permission-reply route (POST /permission/:id/reply
// with {reply}); falls back to the legacy session-scoped route ({response}) for
// older servers. Clears the card optimistically so the UI responds immediately.
export async function respondPermission(sessionID: string, permissionID: string, response: string) {
  setState(
    produce((s) => {
      if (s.permissions[sessionID]) delete s.permissions[sessionID][permissionID];
    }),
  );
  log.debug("permission", "reply", { sessionID, permissionID, response });
  const canonical = await postBounded(
    `/oc/permission/${encodeURIComponent(permissionID)}/reply`,
    { reply: response },
  );
  if (canonical.kind === "ok") return;
  if (canonical.kind === "timeout") {
    // Outcome-unknown: the reply may have landed. Do NOT fall through to the
    // legacy route (a second reply for the same request doubles the
    // ambiguity) and do NOT restore the card — notify honestly.
    replyOutcomeUnknown("Permission", sessionID);
    return;
  }
  if (canonical.kind === "status") {
    log.warn("permission", "canonical reply not ok → legacy route", { status: canonical.status });
  } else {
    log.warn("permission", "canonical reply threw → legacy route", canonical.error);
  }
  const legacy = await postBounded(
    `/oc/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
    { response },
  );
  if (legacy.kind === "ok") return;
  if (legacy.kind === "timeout") {
    replyOutcomeUnknown("Permission", sessionID);
    return;
  }
  log.error("permission", "reply failed on both routes", {
    status: legacy.kind === "status" ? legacy.status : String(legacy.kind),
  });
}

// Reply to a pending question. `answers` is one array of chosen labels (or
// custom strings) per question in the request.
export async function respondQuestion(questionID: string, answers: string[][]) {
  log.debug("question", "reply", { questionID, answers });
  const res = await postBounded(`/oc/question/${encodeURIComponent(questionID)}/reply`, { answers });
  if (res.kind === "ok") return;
  if (res.kind === "timeout") {
    replyOutcomeUnknown("Question");
    return;
  }
  log.error("question", "reply failed", { status: res.kind === "status" ? res.status : String(res.kind) });
}

// Abort a session's turn and clear its working indicator. Exposed for the
// session menu as a recovery path: a turn killed mid-generation (e.g. a network
// drop) can leave OpenCode reporting the session "busy" forever (a zombie turn)
// while the composer's Stop button may be unavailable — this always works.
// Routes through /vh/abort so the server marks the session idle authoritatively
// too (OpenCode emits no session.idle on abort), keeping reconnects consistent.
export async function abortSession(sessionID: string) {
  if (!sessionID) return;
  markSessionIdle(sessionID);
  const res = await postBounded("/vh/abort", { sessionID });
  if (res.kind === "ok") return;
  // Benign either way (the optimistic idle is already applied above and later
  // server events reconcile) — warn-only, no notification: bounding just
  // guarantees the floating promise always SETTLES (a hung socket used to
  // leave it pending forever). A definitive non-2xx stays silent, matching
  // the pre-bound behavior.
  if (res.kind === "timeout") {
    log.warn("abort", "request timed out (no confirmation)", { sessionID });
  } else if (res.kind === "network") {
    log.warn("abort", "request failed", res.error);
  }
}

// Optimistically mark a session idle (used right after aborting a turn) so the
// working indicator clears immediately instead of waiting on server events —
// OpenCode doesn't always emit an idle event on abort. Later events reconcile.
//
// TWO-SLICE CLEAR: there are TWO independent busy indicators driven by TWO
// different store slices that must both clear synchronously before
// `markSessionIdle` returns (two store writes sharing one call stack → Solid
// batches them into one render tick):
//   1. `.working-text`      ← state.activity[sessionID] (the session-busy map).
//   2. `.tree-twisty.running` ← working(node) on the tree NODE (node.activity +
//      node.flags.subtreeBusy), a SEPARATE slice owned by treeState's flat map.
// Without clearing the tree node, the ring persists until the tree stream
// delivers a node.facet(idle) op after the /vh/abort round-trip — which can
// exceed a caller's timeout (the abort e2e flake). Clearing both synchronously
// here (two store writes in one call stack, batched into one Solid render tick)
// makes the ring clear with the shimmer, regardless of when the tree stream's
// idle event later arrives (it becomes a reconciling no-op). Mirrors how the
// normal-completion path (stream.ts case "activity" idle) stamps time.completed
// in the same produce() draft that clears activity — the same
// two-indicators-one-tick intent, here expressed as two synchronous store
// writes (treeState is a separate store, so it can't share the session-store's
// produce() draft).
//
// RE-ARMING SAFETY: /vh/abort marks the session idle SERVER-SIDE authoritatively,
// so any post-abort snapshot or facet op the server emits carries idle — the
// optimistic clear agrees with the authoritative state, never fighting it. A
// stale pre-abort snapshot is the same risk state.activity already has (and the
// server's authoritative idle wins on the next frame). subtreeNeedsInput is
// intentionally NOT cleared: abort kills the busy turn, not a pending input
// request (an input-waiting session is a different concern the abort test does
// not exercise); the server reconciles it if the abort also cancelled the input.
export function markSessionIdle(sessionID: string) {
  setState(
    produce((s) => {
      s.activity[sessionID] = "idle";
      const sm = s.messages[sessionID];
      if (sm && sm.order.length) {
        const last = sm.byId[sm.order[sm.order.length - 1]];
        if (last && last.info.role === "assistant" && !last.info.time?.completed) {
          last.info = { ...last.info, time: { ...(last.info.time || {}), completed: Date.now() } };
        }
      }
    }),
  );
  // Clear the tree node's working state via the canonical facet path so the
  // auto-mutation/normalization logic (working→idle demotion edge) runs
  // consistently with a tree-stream-delivered facet. If the node is not
  // resident (no tree entry), applyTreeOpStore's facet case is a no-op.
  applyTreeOpStore({
    op: "node.facet",
    data: {
      id: sessionID,
      activity: "idle",
      flags: { subtreeBusy: false },
    },
  });
}

// Clear the latched epoch-transition flag. Set by applySnapshot (stream.ts) when
// an epoch transition is detected on a LIVE connection, and consumed here by the
// connection-health toast (ConnectionToast.tsx) once it has surfaced
// "Server restarted — re-syncing…". Exposed as a NARROW action so the public
// sync barrel no longer re-exports the raw store setter (setState) just for this
// one consumer — the only prior external user of that re-export was the toast.
export function consumeEpochChanged(): void {
  setState("epochChanged", false);
}
