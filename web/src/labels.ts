// Label authority: root-session grouping (browser-tab-group style) + tagging.
//
// This is the CLIENT FACADE over the worker-wide server authority established by
// slices 1–3: the durable LabelStore (pkg/web/labels.go → stateBaseDir()/
// labels.json), the GET/PUT /vh/labels CAS API (pkg/web/labels_http.go), and the
// labels.snapshot / labels.updated SSE frames (pkg/web/server.go). It mirrors
// the pin facade (./pins.ts) — confirmed-document adoption, revision
// monotonicity, optimistic mutation, rollback, and exactly one bounded retry.
//
// HOW IT DIFFERS FROM PINS (deliberate, by design — see the approved plan):
//   - NO legacy/localStorage mode and NO migration. Labels have no prior client
//     state; the first labels.snapshot initializes the doc. There is no
//     "initialized" flag (the labels store is born initialized at revision 0).
//   - The wire doc marshals DIRECTLY (no pinsPublicRespFromDoc projection):
//     {revision, groups, tags, tagIdsByRootSessionId} is exactly the wire shape.
//   - The store is the single validation chokepoint: a PUT rejected for any
//     invariant violation yields a structured 400 whose body EMBEDS the
//     self-healed authoritative doc (revision/groups/tags/tagIdsByRootSessionId
//     promoted to the top level). The facade adopts it on BOTH the 400 and 409
//     paths (pins adopt authority only on 409; labels extend it to 400).
//   - IDs are CLIENT-SUPPLIED (the store generates none, matching pins). The
//     facade mints stable group/tag ids via newId() — the frontend twin of
//     pkg/web/queue.go newQueueID, mirrored from web/src/alerts.ts makeId.
//   - ONE unified bounded retry for EVERY intent (including reorder). Pins'
//     performReorder does NOT auto-replay on 409; labels rebase the SAME intent
//     against the adopted authority and retry once, because label reorders are
//     re-applicable cleanly (find-by-id moves survive a concurrent list change).
//
// Mutation basis = the FULL worker-wide doc, always. A client viewing one
// project must never overwrite another project's labels, so every mutation
// derives the next worker-wide doc from the CURRENT authoritative doc — never
// from the render-time project/filter intersection (which is a slice-6 concern
// and would corrupt cross-project state).
import { batch, createSignal } from "solid-js";
import { log } from "./lib/log";

// === Label wire shape (LOCKED contract from slices 1–3) =====================
// Both labels.snapshot and labels.updated decode as this. GET / PUT-200 / 409
// carry the same public doc. The structured 400 body embeds it (with
// error/message/ids alongside). Mirrors pkg/web/labels.go LabelsDoc/LabelGroup/
// LabelTag json tags verbatim.
export interface LabelGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  orderedRootSessionIds: string[];
}
export interface LabelTag {
  id: string;
  name: string;
  color: string;
}
export interface LabelsDoc {
  revision: number;
  groups: LabelGroup[];
  tags: LabelTag[];
  tagIdsByRootSessionId: Record<string, string[]>;
}

// coerceLabelsDoc — defensive parser for a labels frame / response body. Returns
// null only for a shape that cannot yield a usable doc (non-object input); for
// everything else it REPAIRS in-place, mirroring how the server's own
// validateLabelsDoc normalizes (and how coercePinDoc fills defaults). The server
// is the authority and never emits these inconsistencies in practice — this is
// the safe client posture against a corrupt/transient-garbage frame so the UI
// never crashes and the transport can drop (null) or adopt (repaired) sensibly.
//
// Repairs applied:
//   - missing revision → 0; non-array groups/tags → []; non-object
//     tagIdsByRootSessionId → {}.
//   - each group/tag: drop entries lacking a string id; coerce scalars.
//   - duplicate group id → keep the FIRST occurrence, drop later (a server doc
//     never has dupes; a dupe means a corrupt frame).
//   - duplicate tag id → keep the FIRST occurrence.
//   - duplicate root within a group's ordered list → dedupe (keep first).
//   - root in more than one group → keep in the FIRST group (by array order),
//     drop from later groups (exclusive-group invariant).
//   - dangling tag ref in tagIdsByRootSessionId (a tag id not in tags[]) → drop.
//   - empty-string root keys / empty assignment lists → dropped.
// Exported so the stream listener + tests share one validation path.
export function coerceLabelsDoc(o: unknown): LabelsDoc | null {
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;
  const revision = typeof obj.revision === "number" ? obj.revision : 0;

  // --- groups: shape, dedupe-by-id, within-list dedupe ---
  const rawGroups = Array.isArray(obj.groups) ? obj.groups : [];
  const seenGroupIds = new Set<string>();
  const groups: LabelGroup[] = [];
  for (const rg of rawGroups) {
    if (!rg || typeof rg !== "object") continue;
    const g = rg as Record<string, unknown>;
    const id = typeof g.id === "string" ? g.id : "";
    if (id === "") continue; // no usable id → drop
    if (seenGroupIds.has(id)) continue; // duplicate group id → keep first
    seenGroupIds.add(id);
    const orderedRaw = Array.isArray(g.orderedRootSessionIds)
      ? g.orderedRootSessionIds.filter((x): x is string => typeof x === "string")
      : [];
    const orderedRootSessionIds: string[] = [];
    const seenInList = new Set<string>();
    for (const r of orderedRaw) {
      if (r === "" || seenInList.has(r)) continue; // dedupe within the group
      seenInList.add(r);
      orderedRootSessionIds.push(r);
    }
    groups.push({
      id,
      name: typeof g.name === "string" ? g.name : "",
      color: typeof g.color === "string" ? g.color : "",
      collapsed: typeof g.collapsed === "boolean" ? g.collapsed : false,
      orderedRootSessionIds,
    });
  }

  // --- exclusive groups: a root may be in at most one group (keep first) ---
  const rootOwner = new Set<string>();
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const kept: string[] = [];
    for (const r of g.orderedRootSessionIds) {
      if (rootOwner.has(r)) continue; // already claimed by an earlier group
      rootOwner.add(r);
      kept.push(r);
    }
    if (kept.length !== g.orderedRootSessionIds.length) {
      groups[gi] = { ...g, orderedRootSessionIds: kept };
    }
  }

  // --- tags: shape, dedupe-by-id ---
  const rawTags = Array.isArray(obj.tags) ? obj.tags : [];
  const seenTagIds = new Set<string>();
  const tags: LabelTag[] = [];
  for (const rt of rawTags) {
    if (!rt || typeof rt !== "object") continue;
    const t = rt as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : "";
    if (id === "") continue;
    if (seenTagIds.has(id)) continue; // duplicate tag id → keep first
    seenTagIds.add(id);
    tags.push({
      id,
      name: typeof t.name === "string" ? t.name : "",
      color: typeof t.color === "string" ? t.color : "",
    });
  }

  // --- tagIdsByRootSessionId: drop empty keys, dedupe per-root, drop dangling ---
  const tagIdsByRootSessionId: Record<string, string[]> = {};
  const rawAssign = obj.tagIdsByRootSessionId;
  if (rawAssign && typeof rawAssign === "object" && !Array.isArray(rawAssign)) {
    for (const [rootId, rawIds] of Object.entries(rawAssign as Record<string, unknown>)) {
      if (rootId === "") continue; // drop empty key
      const ids = Array.isArray(rawIds)
        ? rawIds.filter((x): x is string => typeof x === "string")
        : [];
      const seenInRoot = new Set<string>();
      const cleaned: string[] = [];
      for (const tid of ids) {
        if (tid === "" || seenInRoot.has(tid)) continue;
        if (!seenTagIds.has(tid)) continue; // dangling tag ref → drop
        seenInRoot.add(tid);
        cleaned.push(tid);
      }
      if (cleaned.length > 0) tagIdsByRootSessionId[rootId] = cleaned;
    }
  }

  return { revision, groups, tags, tagIdsByRootSessionId };
}

export type LabelErrorKind = "labels-conflict" | "labels-network" | "labels-error";

// === Server-authoritative signals ===========================================
// The server doc is THE render + mutation source. Optimistic mutations write
// groups/tags/tagIdsByRootSessionId here directly (NO revision bump); a failed
// PUT rolls back to the captured pre-mutation snapshot. serverRevision is the CAS
// base for the next PUT; it is bumped only by adoptServerDoc (a confirmed server
// frame / 200 response), never by an optimistic write. connected flips true on
// the first labels.snapshot (the bootstrap) — mirrors pins' pinsServerMode but
// without a legacy twin (labels have no legacy path).
const [serverGroups, setServerGroups] = createSignal<LabelGroup[]>([]);
const [serverTags, setServerTags] = createSignal<LabelTag[]>([]);
const [serverTagAssign, setServerTagAssign] = createSignal<Record<string, string[]>>({});
const [serverRevision, setServerRevision] = createSignal<number>(0);
const [connectedSig, setConnectedSig] = createSignal<boolean>(false);

// === Pending-mutation + advisory error state (for slice-6 UI) ================
// pendingCount serializes the boolean view across concurrent in-flight PUTs.
let pendingCount = 0;
const [labelsPendingSig, setLabelsPendingSig] = createSignal(false);
const [labelsErrorSig, setLabelsErrorSig] = createSignal<LabelErrorKind | null>(null);

function incPending(): void {
  pendingCount++;
  if (!labelsPendingSig()) setLabelsPendingSig(true);
}
function decPending(): void {
  pendingCount = Math.max(0, pendingCount - 1);
  if (pendingCount === 0 && labelsPendingSig()) setLabelsPendingSig(false);
}
function clearLabelsErrorSig(): void {
  if (labelsErrorSig() !== null) setLabelsErrorSig(null);
}

// === Project scope (per-project labels) =====================================
// Labels are scoped per-project server-side (commit 23efd32): each project has
// its own revision/CAS domain, its own labels.snapshot bootstrap, and its own
// labels.updated fanout. The facade mirrors this: the signals above hold ONLY
// the active project's labels. resetLabelsScope() clears them on every project
// switch (called from sync/actions.ts switchProject, right after resetTreeStore)
// so the outgoing project's labels vanish IMMEDIATELY, before the incoming
// project's stream connects — matching how switchProject already tears down the
// session map, tree store, and per-project facets.
//
// labelsScopeGen is a monotonic token bumped on every reset. The PUT mutation
// path (performMutation) captures it at issue time and re-checks after each
// await: a late PUT response / retry / rollback arriving from a switched-AWAY
// project is DROPPED rather than adopted into the new project's signals. This
// is the load-bearing guard for the labels-owned async path (the PUT is a
// standalone fetch not covered by the stream's connection-generation guard).
//
// The SSE snapshot/updated frames are guarded SEPARATELY by the transport's
// connection-generation check (treeGen in sync/tree-transport.ts): a frame from
// project A's closed stream is dropped at the listener (`if (gen !== treeGen)
// return;`) before it ever reaches applyLabelsSnapshot/applyLabelsUpdated. A
// snapshot therefore always adopts unconditionally — it IS the new project's
// bootstrap, and the transport guarantees it came from the live connection. A
// labels frame carries no directory field, so the facade cannot distinguish
// projects by content; the connection identity IS the project identity.
let labelsScopeGen = 0;

// resetLabelsScope — clear ALL label signals and advance the scope generation.
// Called on every project switch (and on the no-project teardown) so the
// outgoing project's labels are gone before the incoming project connects, and
// so any in-flight PUT from the outgoing project is invalidated (its captured
// scope gen no longer matches → performMutation drops the late result). Mirrors
// the per-project resets switchProject already performs for sessions/tree.
// Pending is reset too: an in-flight PUT is now an orphan the gen guard will
// drop, so it must not keep labelsPending latched on the new project.
export function resetLabelsScope(): void {
  batch(() => {
    setServerGroups([]);
    setServerTags([]);
    setServerTagAssign({});
    setServerRevision(0);
    setConnectedSig(false);
    setLabelsPendingSig(false);
    setLabelsErrorSig(null);
  });
  pendingCount = 0;
  labelsScopeGen++;
}

// === Read accessors (for slice-5 selectors + slice-6 UI) =====================
// Each returns the signal's current reference. Selectors/UI MUST treat these as
// read-only (never mutate in place): every internal write installs a NEW array
// / map (spread/map/new-object), so a captured reference is a stable snapshot
// between mutations — the SAME immutability guarantee pins' serverOrder() gives
// selectPinnedNodes. Derived structures (groupOf/tagsOf/partition) belong to
// treeSelectors (slice 5) and build atop these accessors.
export const labelsGroups = (): LabelGroup[] => serverGroups();
export const labelsTags = (): LabelTag[] => serverTags();
export const labelTagIdsByRootSessionId = (): Record<string, string[]> => serverTagAssign();
export function labelsDoc(): LabelsDoc {
  return {
    revision: serverRevision(),
    groups: serverGroups(),
    tags: serverTags(),
    tagIdsByRootSessionId: serverTagAssign(),
  };
}
export const labelsRevision = (): number => serverRevision();
export const labelsConnected = (): boolean => connectedSig();
export const labelsPending = (): boolean => labelsPendingSig();
export function labelsLastError(): LabelErrorKind | null {
  return labelsErrorSig();
}
export function clearLabelsError(): void {
  clearLabelsErrorSig();
}

// === ID minting (client-supplied ids — the store generates none) =============
// newId mints a stable client-owned id: <prefix>-<16 hex chars> from 8 random
// bytes. Mirrors web/src/alerts.ts makeId (the frontend twin of pkg/web/queue.go
// newQueueID). globalThis.crypto?.getRandomValues is available in browsers, jsdom,
// and Node ≥ 19 (Node 24 is this project's engine floor); the optional-chain +
// zeroed Uint8Array(8) fallback yields a best-effort id only if crypto is absent
// (older/non-standard runtimes). `lg-` / `lt-` prefixes keep label ids disjoint
// from `q-` (queue), `dev-` (device), and `t:` (terminal tabs) in mixed logs.
function newId(prefix: string): string {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(8)) ?? new Uint8Array(8);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return prefix + hex;
}
const newLabelGroupId = (): string => newId("lg-");
const newLabelTagId = (): string => newId("lt-");

// === Internal doc helpers ===================================================
// currentServerDoc — reads the live signals into a fresh LabelsDoc wrapper. The
// referenced arrays/maps are the signal's current values (stable snapshots, since
// every write installs new collections). Used to capture the mutation baseline.
function currentServerDoc(): LabelsDoc {
  return {
    revision: serverRevision(),
    groups: serverGroups(),
    tags: serverTags(),
    tagIdsByRootSessionId: serverTagAssign(),
  };
}

// applyDoc — optimistic local doc write (NO revision bump). Used for the
// immediate UI feedback before a PUT resolves. Tags are passed through verbatim
// (most intents touch only groups or only assignments).
function applyDoc(doc: LabelsDoc): void {
  batch(() => {
    setServerGroups(doc.groups);
    setServerTags(doc.tags);
    setServerTagAssign(doc.tagIdsByRootSessionId);
  });
}

// adoptServerDoc — the single writer for a CONFIRMED server doc (snapshot,
// updated, or a 200 PUT response). Sets groups + tags + assignments + revision
// together (batched so render sees a consistent snapshot), flips connected, and
// clears any prior advisory error (a confirmed doc supersedes it).
function adoptServerDoc(doc: LabelsDoc): void {
  batch(() => {
    setServerGroups(doc.groups);
    setServerTags(doc.tags);
    setServerTagAssign(doc.tagIdsByRootSessionId);
    setServerRevision(doc.revision);
    setConnectedSig(true);
    clearLabelsErrorSig();
  });
}

// adoptPutResponse — adopt a confirmed PUT-response doc (200 success, 409
// conflict, or 400 self-heal), gated by the SAME revision-monotonicity guard as
// applyLabelsUpdated (mirrors pins' F1). A labels.updated frame adopted between
// the optimistic write and the response landing could otherwise regress client
// state to the (older) response. Equal revision is allowed through (idempotent
// re-adopt). Self-corrects on the next frame. labels.snapshot stays EXEMPT — it
// is the bootstrap reset handled by applyLabelsSnapshot directly.
function adoptPutResponse(doc: LabelsDoc): void {
  if (doc.revision < serverRevision()) {
    log.warn("labels", "dropping stale PUT response (revision regression)", {
      got: doc.revision,
      have: serverRevision(),
    });
    return;
  }
  adoptServerDoc(doc);
}

// rollbackDocIfUnchanged — roll an optimistic doc write back to a captured
// baseline, but ONLY if no fresher authoritative frame landed during the PUT
// round-trip. A labels.updated / labels.snapshot adopted in that window bumped
// serverRevision + the doc; rolling back to the stale baseline would overwrite
// the fresher frame's content while leaving serverRevision at the frame's value
// — a (stale content, fresh revision) split that can lost-update on the next
// mutation. When the revision moved, the fresher frame's doc wins and is left
// intact; the advisory error is still surfaced. (Mirrors pins'
// rollbackOrderIfUnchanged.)
function rollbackDocIfUnchanged(baseline: LabelsDoc, issueRevision: number): void {
  if (serverRevision() !== issueRevision) return; // fresher frame landed — don't clobber
  applyDoc(baseline);
}

// putLabels — the PUT /vh/labels CAS call. X-VH-CSRF is added automatically by
// the SPA's installCsrf() (web/src/csrf.ts wraps window.fetch); tests that stub
// global fetch do not need to set it. 200 and 409 carry the full public doc; a
// structured 400 (any store invariant rejection) carries the self-healed doc
// EMBEDDED (revision/groups/tags/tagIdsByRootSessionId promoted to the top level
// via labelsRejectionResp embedding LabelsDoc) — coerceLabelsDoc reads those
// promoted fields directly, so the 400 body is adopted exactly like a 409. A
// malformed/missing-baseRevision 400 is text/plain (no JSON) → coerce returns
// null → caller treats it as a generic labels-error. status:0 is a synthetic
// network-error sentinel.
async function putLabels(
  baseRevision: number,
  doc: LabelsDoc,
): Promise<{ status: number; doc: LabelsDoc | null }> {
  const body = {
    baseRevision,
    groups: doc.groups,
    tags: doc.tags,
    tagIdsByRootSessionId: doc.tagIdsByRootSessionId,
  };
  try {
    const res = await fetch("/vh/labels", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 200 || res.status === 409) {
      const parsed = await res.json().catch(() => null);
      return { status: res.status, doc: coerceLabelsDoc(parsed) };
    }
    if (res.status === 400) {
      // Structured 400: {error, message, ids?, revision, groups, tags,
      // tagIdsByRootSessionId}. The embedded doc IS the self-healed authority
      // (the server's current doc — nothing was persisted on rejection). Adopt
      // it; the caller re-applies the SAME intent against it and retries once.
      const parsed = await res.json().catch(() => null);
      return { status: 400, doc: coerceLabelsDoc(parsed) };
    }
    return { status: res.status, doc: null };
  } catch (err) {
    log.warn("labels", "PUT /vh/labels network error", { err: String(err) });
    return { status: 0, doc: null };
  }
}

// === Stream entry points (called by sync/tree-transport.ts listeners) ========
export function applyLabelsSnapshot(raw: unknown): void {
  const doc = coerceLabelsDoc(raw);
  if (!doc) {
    log.warn("labels", "malformed labels.snapshot doc", { raw });
    return;
  }
  // The snapshot is the fresh-connect bootstrap: authoritative, always adopted.
  // It is NOT subject to the revision-monotonicity guard (that guards only live
  // labels.updated fan-out); a snapshot resets the base and flips connected.
  adoptServerDoc(doc);
}

export function applyLabelsUpdated(raw: unknown): void {
  const doc = coerceLabelsDoc(raw);
  if (!doc) {
    log.warn("labels", "malformed labels.updated doc", { raw });
    return;
  }
  // An updated frame implies server capability. If one arrives before the
  // bootstrap snapshot (should not happen — snapshot is emitted first on every
  // fresh connect), adoptServerDoc below flips connected defensively.
  // F1 (mirrors pins): revision-monotonicity guard. Drop a live update whose
  // revision is older than the last-applied revision. Guards against concurrent-
  // PUT out-of-order fan-out; self-corrects via labels.snapshot on the next
  // reconnect. Equal revision is allowed through (idempotent re-adopt).
  if (doc.revision < serverRevision()) {
    log.warn("labels", "dropping stale labels.updated (revision regression)", {
      got: doc.revision,
      have: serverRevision(),
    });
    return;
  }
  adoptServerDoc(doc);
}

// === Mutation engine ========================================================
// A LabelsIntent is a PURE transform of the full worker-wide doc → the next doc.
// Modeling intent as a function (rather than pins' typed MembershipIntent) is
// cleaner for labels because every label mutation is a whole-doc transform, and
// it makes the bounded retry trivial: re-apply the SAME function to the adopted
// authority. The intent MUST NOT mutate its input; it returns a fresh doc.
type LabelsIntent = (doc: LabelsDoc) => LabelsDoc;

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

// contentEqual — structural equality over the mutable content (groups/tags/
// assignments), IGNORING revision. Used to detect a no-op intent (skip the PUT)
// and an already-satisfied post-adopt recompute (skip the retry PUT). Revision
// is irrelevant here: both operands derive from the same baseline, so their
// revision fields are trivially equal.
function contentEqual(a: LabelsDoc, b: LabelsDoc): boolean {
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) {
    const ga = a.groups[i];
    const gb = b.groups[i];
    if (
      ga.id !== gb.id ||
      ga.name !== gb.name ||
      ga.color !== gb.color ||
      ga.collapsed !== gb.collapsed ||
      !sameList(ga.orderedRootSessionIds, gb.orderedRootSessionIds)
    ) {
      return false;
    }
  }
  if (a.tags.length !== b.tags.length) return false;
  for (let i = 0; i < a.tags.length; i++) {
    const ta = a.tags[i];
    const tb = b.tags[i];
    if (ta.id !== tb.id || ta.name !== tb.name || ta.color !== tb.color) return false;
  }
  const ak = Object.keys(a.tagIdsByRootSessionId);
  const bk = Object.keys(b.tagIdsByRootSessionId);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const bv = b.tagIdsByRootSessionId[k];
    if (!bv || !sameList(a.tagIdsByRootSessionId[k], bv)) return false;
  }
  return true;
}

// performMutation — the unified mutation engine with exactly ONE bounded retry
// on a 409 (CAS conflict) OR a 400 (store-invariant rejection). Both carry an
// authoritative body the facade adopts before retrying:
//   - 409 body = the concurrent winner's full doc (revision advanced).
//   - 400 body = the self-healed current doc EMBEDDED (revision unchanged — a
//     rejected Replace persists nothing; the embedded doc is what the server
//     already held, with stale refs cleaned by validateLabelsDoc).
//
// Flow: capture baseline → apply intent optimistically (no rev bump) → PUT.
//   200            → adopt confirmed doc.
//   409 | 400      → adopt authority, REBASE the same intent against it
//                    (intent(adopted)), retry ONCE. If the rebased intent is
//                    already satisfied (contentEqual) → no retry PUT. A second
//                    409/400 → adopt final authority, surface labels-conflict.
//   network/other  → roll back to baseline IF no fresher frame landed during the
//                    round-trip (rollbackDocIfUnchanged), surface the error.
//
// Bounded: exactly one retry. A retry that fails non-conflictingly rolls back to
// the adopted authority (the conflict's self-heal / concurrent winner stays).
// This differs from pins' performReorder (which does NOT auto-replay reorder on
// 409): labels rebase every intent because label operations are find-by-id and
// re-apply cleanly against a concurrently-changed doc.
async function performMutation(intent: LabelsIntent): Promise<void> {
  incPending();
  // Capture the project scope at issue time. The PUT is a standalone fetch
  // (dir-scoped via the x-opencode-directory header installCsrf adds from
  // projectDir()), so its REQUEST is always for the project that was active
  // when the mutation started. Its RESPONSE, however, can land after a project
  // switch — and without this guard a late 200/409/400 adoption or a rollback
  // from project A would overwrite project B's signals. Every await below is
  // followed by a scope-gen recheck that drops the result if the scope advanced
  // (resetLabelsScope bumped labelsScopeGen on the switch). The adoption +
  // rollback calls are all SYNCHRONOUS between the awaits, so a switch cannot
  // interleave there — only the two await points are race windows.
  const scopeGen = labelsScopeGen;
  const baseDoc = currentServerDoc();
  const baseRev = serverRevision(); // rollback guard baseline for the first attempt
  // F1-web: a gen-guard drop is a CORRECT discard of an orphaned PUT result (the
  // project switched under it). It must NOT call decPending — resetLabelsScope
  // already zeroed pendingCount, so decrementing on a dropped result would steal
  // a decrement from the new project's in-flight mutation and clear its
  // labelsPending latch early. `dropped` gates the finally (declared outside the
  // try so the finally can read it).
  let dropped = false;
  try {
    const target = intent(baseDoc);
    if (contentEqual(target, baseDoc)) return; // no-op
    clearLabelsErrorSig();
    applyDoc(target); // optimistic
    let res = await putLabels(baseRev, target);
    if (scopeGen !== labelsScopeGen) {
      dropped = true; // project switched — drop late result (skip decPending)
      return;
    }
    if (res.status === 200 && res.doc) {
      adoptPutResponse(res.doc);
      return;
    }
    if ((res.status === 409 || res.status === 400) && res.doc) {
      // Adopt authoritative (409 concurrent winner OR 400 self-healed doc). This
      // is the rollback baseline for the retry.
      adoptPutResponse(res.doc);
      const adoptedDoc = currentServerDoc();
      const retryTarget = intent(adoptedDoc); // REBASE the same intent
      if (contentEqual(retryTarget, adoptedDoc)) return; // already satisfied post-adopt
      const retryRev = serverRevision(); // rollback guard baseline for the retry
      applyDoc(retryTarget); // optimistic retry
      res = await putLabels(retryRev, retryTarget);
      if (scopeGen !== labelsScopeGen) {
        dropped = true; // project switched — drop late retry (skip decPending)
        return;
      }
      if (res.status === 200 && res.doc) {
        adoptPutResponse(res.doc);
        return;
      }
      if ((res.status === 409 || res.status === 400) && res.doc) {
        // Second conflict/rejection — adopt final authority, stop, surface.
        adoptPutResponse(res.doc);
        setLabelsErrorSig("labels-conflict");
        return;
      }
      // Retry failed (non-conflict): roll back to the adopted authority, but
      // only if no fresher frame landed during the retry round-trip.
      rollbackDocIfUnchanged(adoptedDoc, retryRev);
      setLabelsErrorSig(res.status === 0 ? "labels-network" : "labels-error");
      return;
    }
    // First attempt non-200/non-409/non-400 failure (network/500/etc.): roll
    // back the optimistic to the pre-state, but only if no fresher frame landed.
    rollbackDocIfUnchanged(baseDoc, baseRev);
    setLabelsErrorSig(res.status === 0 ? "labels-network" : "labels-error");
  } finally {
    // F1-web: skip the decrement on a gen-guard drop so an orphaned-A PUT that
    // resetLabelsScope already accounted for cannot steal a decrement from B's
    // in-flight mutation. The normal adoption / rebase / retry / rollback paths
    // all set incPending on entry and legitimately own their decPending here.
    if (!dropped) decPending();
  }
}

// === Intent-level public actions ============================================
// Each builds a pure LabelsIntent over the full worker-wide doc and submits it
// via performMutation (PUT with the current baseRevision). All are async (the
// PUT round-trip); the optimistic state reflects immediately for UI feedback.

// createGroup — mint a stable id, append a new (empty) group.
export function createGroup(name: string, color: string): Promise<void> {
  const id = newLabelGroupId();
  return performMutation((doc) => ({
    ...doc,
    groups: [
      ...doc.groups,
      { id, name, color, collapsed: false, orderedRootSessionIds: [] },
    ],
  }));
}

// renameGroup — change a group's name (no-op if the id is unknown).
export function renameGroup(groupId: string, name: string): Promise<void> {
  return performMutation((doc) => {
    let changed = false;
    const groups = doc.groups.map((g) => {
      if (g.id !== groupId) return g;
      changed = true;
      return { ...g, name };
    });
    return changed ? { ...doc, groups } : doc;
  });
}

// setGroupColor — change a group's color token (no-op if the id is unknown or
// the token is off-palette). The server validates colors against the fixed
// token set (pkg/web labels.go); the UI offers only that set, so an off-palette
// value here is treated as a no-op defensively (mirrors how addRootTag ignores
// an unknown tag id). Slice 6 wires this to the group-header manage popover's
// color swatches. A pure intent over the same engine as renameGroup.
export function setGroupColor(groupId: string, color: string): Promise<void> {
  return performMutation((doc) => {
    let changed = false;
    const groups = doc.groups.map((g) => {
      if (g.id !== groupId) return g;
      changed = true;
      return { ...g, color };
    });
    return changed ? { ...doc, groups } : doc;
  });
}

// deleteGroup — remove the group; its roots become UNGROUPED (they are not moved
// elsewhere). Tags + tag assignments are untouched (definitions survive — the
// store's invariant #7).
export function deleteGroup(groupId: string): Promise<void> {
  return performMutation((doc) => ({
    ...doc,
    groups: doc.groups.filter((g) => g.id !== groupId),
  }));
}

// reorderGroup — move the group to newIndex within the groups[] array. No-op if
// the id is unknown or newIndex is the current position (clamped to bounds).
export function reorderGroup(groupId: string, newIndex: number): Promise<void> {
  return performMutation((doc) => {
    const i = doc.groups.findIndex((g) => g.id === groupId);
    if (i < 0) return doc;
    const clamped = Math.max(0, Math.min(newIndex, doc.groups.length - 1));
    if (i === clamped) return doc;
    const next = [...doc.groups];
    const [moved] = next.splice(i, 1);
    next.splice(clamped, 0, moved);
    return { ...doc, groups: next };
  });
}

// moveRootToGroup — EXCLUSIVE: remove the root from EVERY group's ordered list,
// then append it to the target group (or, if groupId is null, leave it removed
// from all groups → ungrouped). Enforces single-membership. A groupId that
// matches no group effectively ungroups the root.
export function moveRootToGroup(rootId: string, groupId: string | null): Promise<void> {
  return performMutation((doc) => {
    const groups = doc.groups.map((g) => {
      const filtered = g.orderedRootSessionIds.filter((r) => r !== rootId);
      if (g.id === groupId && groupId !== null) {
        // target group: ensure the root is present (append at end). filtered
        // already removed any prior occurrence here, so push is safe + deduped.
        return { ...g, orderedRootSessionIds: [...filtered, rootId] };
      }
      // non-target group: root removed if present; unchanged otherwise.
      if (filtered.length === g.orderedRootSessionIds.length) return g;
      return { ...g, orderedRootSessionIds: filtered };
    });
    return { ...doc, groups };
  });
}

// toggleGroupCollapse — flip the group's collapsed flag (no-op if id unknown).
export function toggleGroupCollapse(groupId: string): Promise<void> {
  return performMutation((doc) => {
    let changed = false;
    const groups = doc.groups.map((g) => {
      if (g.id !== groupId) return g;
      changed = true;
      return { ...g, collapsed: !g.collapsed };
    });
    return changed ? { ...doc, groups } : doc;
  });
}

// createTag — mint a stable id, append a new tag definition.
export function createTag(name: string, color: string): Promise<void> {
  const id = newLabelTagId();
  return performMutation((doc) => ({
    ...doc,
    tags: [...doc.tags, { id, name, color }],
  }));
}

// deleteTag — remove the tag definition AND strip every reference to it from
// tagIdsByRootSessionId (a root that had only this tag loses its assignment
// entry entirely). Group definitions are untouched.
export function deleteTag(tagId: string): Promise<void> {
  return performMutation((doc) => {
    const tags = doc.tags.filter((t) => t.id !== tagId);
    const assign: Record<string, string[]> = {};
    for (const [root, ids] of Object.entries(doc.tagIdsByRootSessionId)) {
      const filtered = ids.filter((t) => t !== tagId);
      if (filtered.length > 0) assign[root] = filtered; // else: drop empty key
    }
    return { ...doc, tags, tagIdsByRootSessionId: assign };
  });
}

// addRootTag — assign a tag to a root (deduped; no-op if already present or if
// the tag id is not in the registry). The server validates the root is active;
// a stale/unknown root yields a 400 self-heal (adopted by performMutation).
export function addRootTag(rootId: string, tagId: string): Promise<void> {
  return performMutation((doc) => {
    if (!doc.tags.some((t) => t.id === tagId)) return doc; // unknown tag — no-op
    const cur = doc.tagIdsByRootSessionId[rootId] ?? [];
    if (cur.includes(tagId)) return doc; // already assigned
    return {
      ...doc,
      tagIdsByRootSessionId: { ...doc.tagIdsByRootSessionId, [rootId]: [...cur, tagId] },
    };
  });
}

// removeRootTag — unassign a tag from a root (no-op if absent). Drops the root's
// assignment entry entirely when its last tag is removed.
export function removeRootTag(rootId: string, tagId: string): Promise<void> {
  return performMutation((doc) => {
    const cur = doc.tagIdsByRootSessionId[rootId];
    if (!cur || !cur.includes(tagId)) return doc;
    const filtered = cur.filter((t) => t !== tagId);
    const nextAssign = { ...doc.tagIdsByRootSessionId };
    if (filtered.length === 0) delete nextAssign[rootId];
    else nextAssign[rootId] = filtered;
    return { ...doc, tagIdsByRootSessionId: nextAssign };
  });
}

// dropLabelRoot — LOCAL correction (NO PUT) called from the session.delete /
// prune path when a root is archived or deleted, so a stale root id is evicted
// from the local doc immediately rather than lingering in groups/tag-assignments
// until the server's labels.updated removal frame arrives (or until the next
// mutation's 400 self-heal). The server's lifecycle layer (slice 3) does the
// authoritative RemoveRootIDs + fans out labels.updated; this drop is the eager
// client-side eviction for parity with dropPinnedSession (pins.ts). No-op if the
// root is not referenced anywhere, or before the first snapshot (not connected).
// Group/tag DEFINITIONS are preserved (the store's invariant #7).
//
// NOTE: this is the one public primitive beyond the task's explicit intent list.
// Justified by direct parity with dropPinnedSession and the same stale-ref-
// lingering concern it fixes in the pin path; needed for slice 6's session.delete
// wiring. The S2-style 400 self-heal remains the durable backstop.
export function dropLabelRoot(id: string): void {
  if (!connectedSig()) return; // nothing loaded yet — no-op
  const cur = currentServerDoc();
  let changed = false;
  const groups = cur.groups.map((g) => {
    const filtered = g.orderedRootSessionIds.filter((r) => r !== id);
    if (filtered.length === g.orderedRootSessionIds.length) return g;
    changed = true;
    return { ...g, orderedRootSessionIds: filtered };
  });
  let tagIdsByRootSessionId = cur.tagIdsByRootSessionId;
  if (Object.prototype.hasOwnProperty.call(cur.tagIdsByRootSessionId, id)) {
    const next = { ...cur.tagIdsByRootSessionId };
    delete next[id];
    tagIdsByRootSessionId = next;
    changed = true;
  }
  if (!changed) return;
  applyDoc({ ...cur, groups, tagIdsByRootSessionId });
}

// Test-only: reset ALL label signals so cases don't leak state across each
// other. Mirrors __resetPinnedForTest. Also zeroes labelsScopeGen so each test
// starts from a deterministic scope (resetLabelsScope, which tests call to
// simulate a project switch, then bumps it monotonically from 0).
export function __resetLabelsForTest(): void {
  batch(() => {
    setServerGroups([]);
    setServerTags([]);
    setServerTagAssign({});
    setServerRevision(0);
    setConnectedSig(false);
    setLabelsPendingSig(false);
    setLabelsErrorSig(null);
  });
  pendingCount = 0;
  labelsScopeGen = 0;
}
