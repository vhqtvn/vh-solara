---
research_question: |
  Validate P1-WEB-004's proposed approach (throttle bottommostReadFromDom to
  ~5/sec + capture (sid,candidate) at debounce-arm time so the session-switch
  flush has the correct outgoing session's geometry) against current code, and
  scope a build-ready slice that closes the <400ms debounce-window read-cursor
  loss for the from-bottom scroll-up case without a per-frame layout sweep.
scope: Read-only study of web/src/components/ChatView.tsx, web/src/lib/scroll.ts, web/tests (unit+e2e), pkg/fixtures/opencode.go, git history (5eadea8, c680b94, c2deb17). No files modified.
confidence: HIGH for mechanism + approach + perf-safety; MED for e2e determinism (leading-edge capture is synchronous by construction; real run confirms zero throttle-startup races).
date: 2026-07-05
head: 3991a18
source_policy: Repo-internal only (code, git history, AGENTS.mission.md perf section, sibling memo scroll-follow-app-bugs-study.md).
artifact_type: sources
---

# Read-cursor session-switch loss (P1-WEB-004) — study memo

The bug is authoritatively specified in-code: the comment block at
ChatView.tsx:704-719 (written by commit 5eadea8, P1-WEB-001 Path A) documents
the gap and points to P1-WEB-004 as the future fix.

## (a) Current-code map (HEAD 3991a18 — locate by CONTENT, line numbers drift)
- scheduleReadCursor() :571-574 — the 400ms debounce. Called from exactly one site: onScrolled :906, only in the !atBottom branch.
- flushReadCursor(sid) :578-589 — clearTimeout; draft/no-el guard; if (nearBottom()) { clearReadAnchor(sid); return; } :582-585; else cand = bottommostReadFromDom() :586; if (orderAhead(cand, getReadAnchor(sid), sm()?.order ?? [])) setReadAnchor(sid, cand) :588.
- bottommostReadFromDom() :593-619 — the geometry sweep. scrollEl.getBoundingClientRect().top; loops messages(), per row querySelector+getBoundingClientRect, breaks at first row with top>0. Pure bottommostRead :604. scroll-origin fallback rows[0]?.id :618.
- Session-switch effect :720-742 — createEffect(on(() => props.sessionId, (id, prevId) => {...})). Body: if (prevId) clearTimeout(readCursorTimer) :724 (the loss site); pinnedTop=-1 :731; restoredFor="" :732; setReady(false) :733; requestAnimationFrame(() => { if (!ready()) maybeRestore() }) :736-738.
- onScrolled: self-pin bail :878; atBottom clearReadAnchor :901; scheduleReadCursor :906.
- Unmount flush :835; maybeRestore :626-703; jumpToLatest :554-558; nearBottom :533.
- Send-path jumpToLatest gates (P1-WEB-026/c680b94): sendParts :1193, runShell :1316 — both if (!userScrolledUp()).
- scroll.ts: getReadAnchor :35, setReadAnchor :42, clearReadAnchor :51, bottommostRead :78, orderAhead :97-105 (P1-WEB-002/c2deb17).

## (b) The <400ms loss mechanism
Scenario: session X at bottom (anchor cleared/undefined). User scrolls UP.
- Idle >=400ms then switch: debounce fires :573 → flushReadCursor(X) → bottommostReadFromDom measures X (still current) → setReadAnchor(X, cand). No loss. (unread-dot.spec.ts test 3 exercises this via waitForTimeout(600) :211.)
- Switch <400ms later: debounce still pending. Switch effect :724 clearTimeout(readCursorTimer) — pending flush NEVER runs. X's anchor stays cleared. Reopen X: maybeRestore :628 reads getReadAnchor(X) → undefined → no-anchor branch :687-699 → pins to bottom. The scroll-up read position is LOST entirely.
It is a MISSED CAPTURE in the was-at-bottom-origin scroll-up case. Why the flush can't just run at switch time: by the time the effect runs, memo/DOM have flipped to the entering session (:707-709), so bottommostReadFromDom would measure the WRONG session and sm()?.order :588 would be the entering session's order.

## (c) Approach validation — PROPOSED APPROACH HOLDS, with TWO mandatory refinements
Validated: arm-time geometry is stable + correctly attributed (scheduleReadCursor runs from onScrolled on a real scroll-away; layout is settled; props.sessionId IS the outgoing session). Throttle needs no new timer (timestamp gate). Leading-edge capture makes the switch-flush deterministic. No simpler alternative avoids the stash (switch effect reads flipped DOM; no session-blur event).

REFINEMENT 1 (MANDATORY, single riskiest step) — invalidate the stash on return-to-bottom. Without it, scroll-up → return-to-bottom → switch re-sets a stale mid-history anchor. Clear armedCand at every anchor-clear site: flushReadCursor nearBottom :583 and onScrolled atBottom :901.

REFINEMENT 2 — switch flush must use the OUTGOING session's order. flushReadCursor uses sm()?.order :588 (CURRENT session = entering at switch). The switch flush must read state.messages[prevId]?.order.

## (d) Perf-safety audit
bottommostReadFromDom cost: 1 getBoundingClientRect on scrollEl + N x (querySelector+getBoundingClientRect), N = rows above fold to first row below viewport top. Reads-only loop → ONE layout flush. At 5/sec (200ms throttle) = CPU layout-read, categorically different from the GPU re-raster heat saga (mask-image on .chat-scroll at 60fps). Naturally idle during streaming (follow→self-pin bail; scrolled-up→no scroll events). Perf-safe.

## (e) Contradiction audit — NONE blocking
orderAhead (P1-WEB-002): safe — switch flush applies orderAhead against outgoing order. maybeRestore (P1-WEB-022): safe — written anchor valid id. Send-path jumpToLatest gating (P1-WEB-026): safe — !userScrolledUp() gate REDUCES stale-stash hazard; atBottom invalidation still required for manual scroll-back. a4a7f7c/750562c/4fa8255/Deferred/messagesError: no shared path. Ordering: switch flush writes outgoing session's anchor; entering session's maybeRestore reads a different key — no cross-session race.

## (f) Test strategy
e2e (not unit — logic is DOM-coupled). No fixture change (existing other/demo sessions suffice; the slow session is unrelated). Two new cases in web/tests/e2e/unread-dot.spec.ts:
1. <400ms regression: scroll up → switch FAST (NO waitForTimeout) → reopen → assert NOT at bottom.
2. Invalidation guard: scroll up → scroll back to bottom → switch → reopen → assert AT bottom.
Determinism: leading-edge capture is synchronous. Run new tests at --repeat-each=5 --retries=0 initially.

## (g) Build-ready scoping
Files: web/src/components/ChatView.tsx ONLY (~15 lines). No scroll.ts/fixture/CSS change. Change shape + test plan in the implementation spec below.
Single riskiest step: forgetting the stash invalidation at :583 and :901.
