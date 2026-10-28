# S4 Option-A migration-feasibility study — OpenCode v2.0.32 (witness-backed queue scheduler)

> Promoted-from: tmp/agent-runs/s4-v2-migration-feasibility-20261028/packet.md  
> Original date: 2026-10-28  
> Provenance: researcher pass, 2026-10-28, read-only static study; upstream reads tag-pinned at v2.0.32; decision context: S4 disposition solution brief `tmp/agent-runs/s4-disposition-20261027/brief.md` + committed `researches/decisions/2026-10-27-queue-dispatch-annex-3-upstream-witness.md` §6  
> Canonical upstream: `anomalyco/opencode` (`sst/opencode` redirects there). Upstream reads tag-pinned at v2.0.32 (releases.atom read live once, for Q6 churn only). No repo/upstream code executed.  

## Verdicts

- Q1 (S3 disclosed-unread internals): **supported** — all four sub-gaps now read at source.
- Q2 (row-8 tree composition): **supported, buildable** — composition over durable per-session
  terminals + parent_id linkage + subagent Job records; no single tree-terminal event (gap is real but bounded).
- Q3 (W4 TOCTOU): **partially closed** — per-session folding harm eliminated by queue delivery +
  doorbell; tree-wide exclusion still requires the daemon gate.
- Q4 (surface map): brief's sizes confirmed; several NEW surfaces (archive-set HTTP gone, /api prefix,
  required password auth, in-place v1→v2 DB migration trigger).
- Q5: isolated-instance evaluation first (spawned topology, NOT --opencode-url), per-instance cutover
  as end-state; dual-protocol binary not recommended.
- Q6: no static blocker found; 9 runtime verifiers remain; **churn: v2.1.0…v2.2.0 shipped within 11
  days of v2.0.32; v2.2.0 (today) carries breaking changes** — candidate tag must be re-pinned before adoption.

## Q1 — closed gaps (all @v2.0.32, file+symbol)

### Drain internals (runner/llm.ts `SessionRunner.drain`, `advanceToStep`; runner/index.ts `DrainResult`)
- Fresh execution (not force, not continuing): `nextPromotable(db, sid, "input")`; nothing pending →
  `DrainResult.Complete()` (execution settles). Steer-scoped execution + queue item pending → Complete
  (steer never promotes queued next-turn work).
- Drain start settles crash leftovers: `settleStaleCompactions` (running compactions → Compaction.Failed),
  `settleStaleToolCalls` (streaming/running tools → Tool.Failed; subagent tool state carries child sessionID).
- `advanceToStep` reads nextPromotable under `SessionInbox.serialized` (per-session keyed mutex) with scope
  `entering || !continuing ? "input" : "steer"` — idle/entry boundary may take ONE queued item; mid-turn
  boundaries take steers only. Compaction/move controls handled inline (move → DrainResult.Moved;
  compaction runs then loop continues).
- Promotion = `SessionInbox.promote(db, bus, sid, scope)` (inbox.ts): steers first (compaction reordered
  ahead of earlier steers, never across a move), else (scope "input") oldest queued; delivery publishes
  `InboxDelivered` which deletes the pending row + projects the message in the SAME transaction.
- Turn loop: `while(true){advanceToStep; runStep; step++; entering=false}` — after a turn ends,
  scope returns to "input": a queued item admitted mid-turn becomes the NEXT turn INSIDE THE SAME
  execution (busy period). One terminal covers every coalesced drain (execution.ts settled).
- Coordinator (run-coordinator.ts): `wake` on active execution sets `pendingWake` (widest scope wins:
  "input" subsumes "steer"); loop adopts it and drains again; a doorbell rung after loop end (or during
  cleanup) starts a successor execution at `settle`. `run` joins; `awaitIdle` follows successors;
  `interrupt` claims recorded wakes, wakes during cleanup restart at settle.

### session.prompt return shape (server/src/handlers/session.ts `session.prompt`; core session.ts `prompt`)
- `POST /api/session/:sessionID/prompt {id?, text, files?, agents?, skills?, metadata?, delivery?,
  resume?}` → success `{ data: SessionInbox.User }` — the DURABLE ADMISSION record
  {id, sessionID, time.created, payload, delivery}. Acknowledgment, NOT completion. No messageID→run
  correlation in the response beyond the admission itself.
- Service flow: `messageID = input.id ?? create` → `admission.reconcile` (idempotency: existing pending
  row OR already-promoted message with same id → returns existing) → else `SessionPrompt.prepare` +
  `admission.admit` (publishes `session.inbox.enqueued`; transactional pending-row insert,
  onConflictDoNothing). `SessionInbox.LifecycleConflict` → `PromptConflictError` → HTTP **409**
  (same id, different session/type). Whole admission `Effect.uninterruptible`.
- `resume !== false` (default) → `execution.wake(sessionID)` (doorbell). `resume:false` = park durably
  without waking — BUT any other actor's wake later promotes it (parking is not a hold).
- steer vs queue server-side: steer rows promote at the next step boundary (mid-turn); queue rows
  promote only at idle/entry boundaries (next turn). `session.inbox.update` PATCH flips delivery
  (steer wakes execution); `session.inbox.cancel` DELETE (idempotent no-op on unavailable);
  `session.inbox.list` GET.

### session.log framing (protocol groups/session.ts `session.log`; schema/event.ts, event-log.ts)
- `GET /api/experimental/session/:sessionID/log?after=<seq>&follow=true|false` → **SSE**
  (`HttpApiSchema.StreamSse`) of `SessionEvent.Durable | EventLog.Synced`.
- `after` is EXCLUSIVE per-aggregate (session) seq. Envelope: `{id:"evt_…", created, metadata?, type,
  location?, data, durable:{aggregateID, seq, version}}` — durable events carry the seq cursor.
- `log.synced {aggregateID, seq?}` marks replay→live boundary ("reader holds every event committed at
  or below this watermark"; seq absent when watermark empty). Cursor = durable.seq, monotonic, stable
  across reconnect. Global `GET /api/event` SSE is live-only ("volatile by contract … events during
  disconnection are missed").

### Claim lifecycle on crash (store.ts, execution.ts, server process.ts)
- Claim = `session_v2.time_suspended` (NOT NULL) + `resume_attempts`. `claim()` sets it idempotently
  (null-guard: re-claim is a no-op) in the same transaction as `session.execution.started`
  (`claimOnCommit`); terminals release (`releaseOnCommit`) EXCEPT shutdown-interruption which preserves
  it. Comment: "recovery is a property of the database, never of a shutdown hook".
- After SIGKILL: claim survives, no terminal → visibly "claimed, unterminated" (honest hold).
- Next boot: `installRestartContinuity` (process.ts) forks `SessionRestart.resumeSuspendedSessions`
  — resumes sessions whose claim was never released; `listSuspended()` = top-level claimed sessions;
  `releaseChildClaims(recoverable)` clears orphaned child claims except recoverable background subagent
  jobs (resumed via durable Job records); `countResume` durably counts resume attempts.

## Q2 — tree composition inputs (@v2.0.32)

- Durable parent/child: `session_v2.parent_id` (+ index, + fork_session_id); `session.create
  {parentID}` creates a linked child at parent's location; `session.list?parentID=<id|null>` filters
  (null = roots). DELETE cascades to child sessions.
- Per-session terminals/claims: durable `session.execution.*` in each session's log; claim state is a
  session-table column (queryable per session).
- Child completion observable: subagent children run as durable `Job` records (type "subagent",
  recovery {childSessionID, parentSessionID, description, agent}); `SubagentJob.start` resumes the child
  and extracts completion text; `SubagentCompletion.deliver` posts a durable **synthetic message into
  the parent** (metadata {source:"subagent", childID, agent, state}); background children outlive the
  parent's step (observer forked in global scope; jobs+observers outlive the launching plugin).
- Orphans: boot clears orphaned child claims (except recoverable jobs); crashed running subagent tools
  are settled `Tool.Failed` with child sessionID in metadata at the parent's next drain.
- Composition shape: daemon keeps tree map (list?parentID per level + live session events), tracks
  per-session last durable seq, subscribes global /api/event for live + per-session session.log for
  replay; tree-idle = no session in tree holds an active execution or unreleased claim; discharge per
  the S3 rule (terminal at seq > my inbox.delivered seq AND no pending inbox item with seq ≤ mine).
- Gaps (real, bounded): no single tree-terminal event; tree can grow between check and terminal
  (late-appearing descendants — global SSE gives live session.created; new members' logs readable from 0);
  SIGKILL-without-restart = indefinite honest hold (memo state 4: `completion_evidence_unavailable`).

## Q3 — W4 (idle-check→POST TOCTOU)

What v2 closes: (1) admission atomicity + caller-ID idempotency (409/reconcile) kills lost/dup
admission races; (2) `delivery:"queue"` + doorbell ordering means an item admitted while a turn is
running CANNOT fold into that turn — it becomes the next turn of the busy period (runner/llm.ts scope
rules + inbox.promote). The v1 W4 harm class ("queued instruction folds into the ongoing turn") is
eliminated per-session.
What v2 does NOT close: tree-wide exclusion. Queue contract is whole-TREE idle; v2's barrier is
per-session. A root-queued item still runs while a sibling/descendant session is busy. Also parking
upstream with resume:false is NOT a hold — any other actor's wake promotes it.
Daemon posture: keep local custody + S2 tree gate in front of the POST; POST with delivery:"queue" at
tree-idle. Residual race window re-characterized: if another actor starts work between check and POST,
the item runs as the next turn after that work (waits for it, no interleaving) instead of folding into
it — milder, arguably conformant to intent, but still a deviation from "tree observably idle at
dispatch" — operator-visible nuance, not silently absorbed.

## Q4 — corrected migration surface map (sizes = brief's, confirmed unless noted)

| Surface | Concrete change @v2.0.32 | Size |
|---|---|---|
| Client/admission | prompt_async → POST /api/session/:id/prompt {id, delivery, resume}; 409+reconcile idempotency; inbox.list/cancel/update; wait/interrupt/active; **required password auth** (process.ts ServerAuth, username "opencode"); ALL paths move under /api/* | L (confirmed) |
| DB layer | v2 tables: session_v2 (incl. time_archived, time_suspended=claim, resume_attempts, parent_id), session_message (per-session seq), session_pending, session_inbox, instruction_*; WAL pragmas match vh-solara's writer posture; **in-place migration trigger: DB with `session` table → applyOnly(migrations)** (migration.ts) — v1-import details in migration.gen.ts UNREAD; default DB filename for v2 serve UNVERIFIED | M, high consequence (confirmed; new: archive+auth+filename items) |
| Unarchive/index | unarchive SQL retargets `session_v2.time_archived`; **v2 session.update accepts ONLY title/metadata/permissions → HTTP archive-SET is gone too** (v1 PATCH time.archived has no v2 equivalent found); v2 session.list has NO archived filter (archived listing surface unresolved); session-list index convergence re-derived (cursor pagination, default limit 50) | M (confirmed; scope grew: both archive directions now direct-SQL or reworked) |
| Ingestion/reducers | whole new event taxonomy (session.execution.*, session.inbox.*, step.*, durable envelopes {durable:{aggregateID,seq,version}}); typed message model incl. idle markers as messages; TranslatorV2 needed (translate.go swap point exists); hydrate reshaped (cursor-paged lists; session.active vs /session/status) | L (confirmed) |
| Proxy/direct FE | /oc passthrough survives mechanically BUT v2 needs path/payload translation or an FE adapter; **12 FE files hit /oc directly** (api, projects, git, models, complete, swPolicy×6, actions, export, sessionTitle, SessionContextMenu, createSend, createMessageActions); createSend.ts:712 direct prompt_async POST (:880 /shell) | M–L (confirmed) |
| FE SSE | /vh/stream normalized contracts preserved IF the backend translator maintains them; vh-solara store-seq cursor unaffected upstream-side; global /api/event live-only + per-session log catch-up is a BETTER recovery substrate than v1 (no more full rehydrate-on-reconnect necessity) | M, conditional (confirmed; upside noted) |
| Fixtures | rebuild fake upstream on v2 API: /api paths, auth, prompt admission (id/delivery/409), inbox table semantics, execution terminals, session.log SSE + log.synced, session.active, subagent job/completion synthetic, claim/resume (restart continuity) | L (confirmed) |
| Local-server | spawn/health/version/restart mostly unchanged BUT v2 serve requires password (spawn handshake); `opencode db path` CLI survival unverified; version detection must gate v1/v2 client selection | M–L (confirmed) |
| Tree-witness scheduler | NEW build on: durable per-session terminals + seq cursors, parent_id/list?parentID, claim column as honest-hold signal, subagent Job records + parent synthetic completions, global SSE live + per-session replay | L (confirmed; inputs now concrete) |

Direct-SQL need (question asked): v2's event/sync API REPLACES the need for vh-solara's read-side SQL
(there was none — reads were HTTP already) but the UNARCHIVE write-side SQL becomes MORE necessary
(archive-set HTTP gone), now against session_v2; the self-check pattern (assertSessionSchema) ports.

## Q5 — deployment shapes

(a) Isolated-instance evaluation — FEASIBLE, CHEAPEST, SAFEST. Spawned topology on a scratch
machine/clone (NOT --opencode-url: cmd/local-server.go:232-238 refuses daemon dispatch in external
mode — custody fence available, restart causality barrier not certified; that refusal is
topology-based, applies to v2 too unless amended). Fresh v2 DB (own data dir) = zero data conversion;
a COPY of prod v1 opencode.db can trial the in-place migration separately. Pending admissions: none
carried (scratch clone's .vh-solara queue.json is disposable). Rollback: delete the scratch dir.
(b) Dual-protocol binary — feasible-in-principle (translator + vh-owned SSE boundaries exist), most
expensive (12 FE direct-call files; two DB schemas; two auth postures; proxy translation layer). NOT
recommended now.
(c) Per-instance cutover — realistic end-state. Quiesce v1 → snapshot DB (in-place migration NOT
proven reversible) → start v2 (migrates DB in place when `session` table present) → carry local
queue.json (items pending locally, not yet admitted upstream, survive) → rollback = restore DB
snapshot + v1 binary. Pending-admission transition risk is LOW because vh-solara admissions are local
until POST; the risky conversion is upstream's v1→v2 DB import (migration.gen.ts unread).
Recommendation: (a) now for evidence, (c) later for adoption, (b) never unless per-project mixed
versions become a hard requirement.

## Q6 — GO/NO-GO

Churn (live releases.atom, 2026-10-27): v2.0.32 (10-16) → v2.1.0 (10-20) → v2.1.1 (10-20) → v2.1.2
(10-21) → v2.1.3 (10-22) → v2.1.4 (10-23) → v2.2.0 (10-27, TODAY; includes breaking changes in
@opencode/ai root exports, GitHub Action removal, OpenTUI 0.7 req). 1.x maintenance continues
(v1.19.4, 10-22). GA ~Oct 12–14 → v2 line is ~2 weeks old with 7+ releases and intra-minor breaking
changes. v2.0.32 is already stale as a deployment candidate; any adoption must re-pin and re-verify.

Runtime verifiers remaining (NOT executed; each needs separate authorization):
V1 prompt idempotency/409 against real SQLite; V2 doorbell/drain under concurrent steer+queue
(rows 1–7 live); V3 SIGKILL mid-turn → claim survives → restart resumes → terminal observed;
V4 subagent row-8: child outlives root step, child terminal via global SSE + child log, parent
synthetic; V5 session.log cursor stability + follow catch-up across reconnect; V6 DB cutover: v2 over
a COPY of prod v1 DB (in-place migration correctness, v1-binary-after rollback probe, filename
defaults/channel DBs); V7 spawned-serve password handshake + `opencode db path` survival; V8 daemon
tree-witness prototype (discharge rule end-to-end incl. claimed-unterminated hold); V9 full contract
re-verification at the chosen deployment tag.

GO requires: all verifiers green at the pinned candidate tag + operator accepts the migration cost and
the W4 residual nuance. NO-GO triggers: v1→v2 import drops/corrupts data; resume loop instability
(resume_attempts runaway); session.log replay gaps; breaking churn at the candidate tag touching
inbox/execution/log surfaces.

## Contradictions

1. S3 cited the prompt service at `core/src/session/prompt.ts` — that file is payload PREPARATION; the
   service (admission flow, 409 mapping, wake/resume) is `core/src/session/session.ts`. Locator
   correction; substance unchanged.
2. S3's disclosed gap "runner/prompt/ drain internals" — `runner/prompt/` holds only a system-prompt
   template; the drain loop is `runner/llm.ts`. Gap closed; S3's inference (queued items continue the
   busy period) confirmed as fact.
3. S3 listed interrupted reason "superseded"; execution.ts source shows user|shutdown|inactivity.
   Schema-level enum per S3 not re-verified — flagged.
4. Brief E13 "external-URL mode disables daemon dispatch" — confirmed, but the mechanism is the
   uncertified restart causality barrier (local-server.go:234), not custody or version; a v2 trial
   inherits the same topology rule.
5. Brief migration table said "do not assume compatibility or safely reversible conversion" —
   confirmed apt: migration.ts shows in-place migration of a v1 DB (session table present →
   applyOnly); reversibility unknown (migration.gen.ts unread).
6. Release landscape moved: S3/brief treated v2.0.32 as latest; v2.2.0 shipped today. Not a
   contradiction of S3 (correct at its date); time-sensitive fact refreshed.

## Evidence tier

READ @v2.0.32 (this session): server/src/handlers/session.ts; core/src/session/{session,prompt,inbox,
store,execution,run-coordinator}.ts; core/src/session/runner/index.ts; runner/step.ts; runner/llm.ts;
subagent-job.ts; subagent-completion.ts; protocol/src/groups/{session,message,event}.ts;
core/src/session/sql.ts; schema/src/{event,event-log}.ts; core/src/database/{database,migration}.ts;
server/src/process.ts. Directory listings: core/src/session/, runner/, runner/prompt/, protocol
groups/, server/src/. Live: releases.atom (2026-10-27).

NOT read (disclosed): migration.gen.ts/schema.gen.ts (v1-import bodies); execution/restart.ts
(resumeSuspendedSessions body); schema/src/session.ts (Session.Info field exposure of
time_suspended/time_idle); schema/src/session-event.ts @v2 (relied on S3's full read); job.ts;
projector.ts; compaction.ts/context.ts/model-transport.ts; v2 CLI default DB filename; any tag other
than v2.0.32; v2 docs site.

Repo files read: the four must-read docs; pkg/opencode/db.go, client.go; pkg/state/translate.go,
store.go (1290–1439), reducers.go (280–409); pkg/aggregator/lifecycle.go, hydration.go;
pkg/web/opencode_proxy.go, queue_drain_loop.go, server_routes.go (routes); cmd/local-server.go
(200–549); pkg/fixtures/opencode.go (targeted); web/src/lib/queueDispatchMode.ts; web/src/sync
tree-transport.ts + session-stream.ts (targeted); FE /oc usage greps.

## Findings (structured)

- (finding) session.prompt returns the durable admission record (ack, not completion); 409 only on
  same-id/different-session-type conflict; same-id replay is idempotent. source=v2.0.32
  server/handlers/session.ts + core session.ts `prompt`, inbox.ts `reconcile|admit`. confidence=high. type=fact
- (finding) queue delivery = next turn within the same busy period; steer = mid-turn injection; the
  doorbell guarantees admitted work is drained before settle and a successor execution catches
  late doorbells. source=runner/llm.ts `drain|advanceToStep`, run-coordinator.ts `wake|settle`. confidence=high. type=fact
- (finding) session.log = SSE, exclusive per-session seq cursor, durable envelopes, log.synced
  replay→live marker; global /api/event live-only. source=protocol groups/session.ts+event.ts,
  schema/event.ts+event-log.ts. confidence=high. type=fact
- (finding) claim = session_v2.time_suspended+resume_attempts, write-ahead with execution.started,
  released on terminals except shutdown; boot resumes suspended sessions (process.ts
  installRestartContinuity); orphaned child claims cleared except recoverable jobs. confidence=high. type=fact
- (finding) v2 API is /api/*-prefixed, requires password auth, has no HTTP archive-set and no
  archived list filter; session table renamed session_v2. confidence=high (absence verified across the
  session/message groups; archive could not be exhaustively excluded repo-wide). type=fact
- (finding) subagent children are durable Job records linked parent↔child; completion delivers a
  durable synthetic into the parent; background children outlive the parent step. confidence=high. type=fact
- (inference) tree composition is straightforward event algebra over durable per-session terminals
  with three bounded gaps (no tree-terminal event; late-appearing descendants; SIGKILL-no-restart
  indefinite hold). confidence=medium-high.
- (inference) W4 harm reduces from "folds into running turn" to "runs as next turn after concurrently
  started work" per-session; tree-wide exclusion still daemon-side. confidence=medium-high.
- (assumption) deployment recommendation (a)→(c), never (b) — synthesis from cost/risk, not evidence.

Artifact type: sources (evidence base). Next: operator disposition; if GO, authorize isolated-instance
runtime verifiers (separate exec authorization) and re-pin the candidate tag first.

---

## Disposition (operator decision, 2026-10-28)

- **vh-solara remains on the OpenCode v1 line** (pinned `v1.18.14`, `pkg/opencode/db.go:50`; 1.x maintenance observed alive through `v1.19.4`, 2026-10-22).
- **v2 migration is DEFERRED, not rejected**: this study found no static blocker; the witness path is real and concrete.
- **If/when revisited**:
  - The GO gate is the study's runtime verifiers **V1–V9 green at a re-pinned candidate tag** (`v2.0.32` is stale — 7 releases since; `v2.2.0` shipped 2026-10-27 with named breaking changes outside the session HTTP API).
  - DB cutover proven on a copy with snapshot rollback.
  - Operator acceptance of the W4 residual nuance (queue item admitted as other work starts runs immediately after it, not folded into it).
- **Revisit triggers**:
  1. (a) v2 release pace settles with no breaking churn touching the inbox/execution/log surfaces at the candidate tag.
  2. (b) The witness-backed Send-now/Queue feature becomes a wanted deliverable.
  3. (c) Any signal that 1.x maintenance is ending.
- **Cross-references**:
  - Decision record: `researches/decisions/2026-10-27-queue-dispatch-release-rule.md` (Path A; O3 gate unchanged).
  - Annex 3: `researches/decisions/2026-10-27-queue-dispatch-annex-3-upstream-witness.md` §6 options A/B — Option A executed as this feasibility study; Option B not taken.

### Revisit status (2026-10-28 spot-check, tag v2.2.0)

Read-only stability check of the seven witness symbol groups this study
relies on, re-verified in source at v2.2.0 (latest release, 2026-10-27;
packet: tmp/agent-runs/s4-v2-witness-stability-check-20261028.md,
disposable):

- **All seven groups unchanged at v2.2.0** — prompt admission + reconcile
  idempotency + 409 conflict; durable inbox; drain/promotion scope rule
  (`entering || !continuing ? "input" : "steer"` verbatim); one durable
  terminal per busy period; claim lifecycle + restart continuity;
  `session.log?after&follow` replay; tree inputs (`parent_id`,
  `session.list?parentID`, subagent Job records + parent synthetics).
  No named breaking change in v2.1.0→v2.2.0 touches any witness group.
- **Verdict: WATCH** — broader event taxonomy churned (v2.1.0 renamed
  provider-replay fields `state*` → `native*`, removed unused
  `session.compacted`), so a future TranslatorV2 target moved; also
  additive: **session archiving was restored in v2.1.0** (#53759), which
  favorably flips this study's Q4 "Unarchive/index" row (archive-set no
  longer direct-SQL-only — re-verify exact shape at revisit).
- **Revisit cost**: a ~1-day delta refresh (native-field renames,
  `session.compacted` removal, archive restoration, source-tree move
  under top-level `packages/`), not a full re-study.
- Note: v2.0.32 findings in this file remain historical (tag-pinned);
  do not treat them as the current upstream shape.

