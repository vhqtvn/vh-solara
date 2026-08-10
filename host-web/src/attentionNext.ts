import type { Attention } from "./dockview/types";
import {
  activeWorkspaceId,
  firstNeedsYouAtFor,
  focusedId,
  hostOps,
  setActiveWorkspace,
  statusFor,
  workspaceApiFor,
  workspaces,
} from "./dockview/store";
import { exitKeyboardFocus, isKeyboardOpen } from "./keyboardFocus";

// =============================================================================
// P3 ATTENTION HUB — NEXT hero button logic.
//
// The statusbar's attention-hub surfaces "N need you · M running" (N/M computed
// in store.ts from the ACTIVE workspace's panes) and a NEXT hero button. The
// button is VISIBLE only when the active workspace has at least one needs-you
// pane (ws-scoped visibility — the locked choice; background-workspace needs-you
// is already carried by the per-workspace-tab badge from P1, so the statusbar
// does not duplicate it).
//
// RANKING SCOPE (noted fork resolution). The mission text specifies BOTH "rank
// the needs-you panes in the active workspace" AND a cross-workspace click
// branch + cross-workspace e2e. With active-workspace-only ranking the target is
// always in the active workspace, which makes the cross-workspace branch dead
// code and the cross-workspace e2e unwritable. The only coherent reconciliation
// within the settled assumptions (none forbid it) is: VISIBILITY is active-ws
// (locked), but RANKING is GLOBAL across all workspaces. So when the button is
// visible (active-ws has a need), NEXT routes to the single highest-priority
// needy pane system-wide — which may be in the active workspace (common case) or
// a background workspace (when a background pane outranks every active-ws pane).
// This is coherent: the button appears because attention is needed in the active
// ws; NEXT then takes the operator to the MOST urgent need globally, switching
// workspaces if necessary.
// =============================================================================

/** A ranked needs-you candidate (one per pane currently in a needs-you state). */
export interface NeedyCandidate {
  paneId: string;
  wsId: string;
  attention: Attention;
  /** Host-latched timestamp of the none→non-none transition (0 if unset). */
  firstNeedsYouAt: number;
}

/** Attention priority for ranking: needs_permission (a grant the operator must
 *  allow) outranks needs_reply (a clarifying answer). "none" is last but never
 *  present in the candidate set (filtered out). */
const ATTENTION_RANK: Record<Attention, number> = {
  needs_permission: 0,
  needs_reply: 1,
  none: 2,
};

/**
 * Enumerate + rank every needs-you pane across ALL workspaces. Rank order:
 *   1. attention (needs_permission before needs_reply)
 *   2. host-latched firstNeedsYouAt ascending (oldest need first)
 *   3. stable paneId tiebreaker (deterministic when timestamps collide)
 *
 * Reads the GLOBAL statusByPane (via statusFor) + the live per-workspace
 * Dockview apis (via workspaceApiFor) to map each needy pane to its owning
 * workspace. Pure/read-only — no side effects. Returns a fresh sorted array.
 */
export function rankNeedy(): NeedyCandidate[] {
  const out: NeedyCandidate[] = [];
  for (const ws of workspaces()) {
    const api = workspaceApiFor(ws.id);
    if (!api) continue;
    for (const panel of api.panels) {
      const st = statusFor(panel.id);
      if (!st || st.attention === "none") continue;
      out.push({
        paneId: panel.id,
        wsId: ws.id,
        attention: st.attention,
        firstNeedsYouAt: firstNeedsYouAtFor(panel.id) ?? 0,
      });
    }
  }
  out.sort((a, b) => {
    if (a.attention !== b.attention) {
      return ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention];
    }
    if (a.firstNeedsYouAt !== b.firstNeedsYouAt) {
      return a.firstNeedsYouAt - b.firstNeedsYouAt; // oldest first
    }
    // Stable paneId tiebreaker (deterministic when two needs landed in the same
    // millisecond, which is reachable under rapid status probes).
    return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
  });
  return out;
}

/** Inspect the ranking WITHOUT acting: returns the highest-priority needy pane
 *  system-wide, or null when no pane needs you. The DEV bridge exposes this so
 *  the e2e can assert the ranking before/after a click. */
export function nextTarget(): NeedyCandidate | null {
  return rankNeedy()[0] ?? null;
}

/**
 * The NEXT hero button click action. Resolves the highest-priority needy pane
 * system-wide and:
 *   1. CROSS-WORKSPACE — if the target lives in a non-active workspace, activate
 *      that workspace first (a survival-safe CSS-visibility-only switch; no
 *      iframe reloads). The per-ws-tab badge already signaled the background
 *      need; this is the natural follow-through.
 *   2. RESTORE-FROM-TRAY — if the target pane is collapsed (parked in a floating
 *      group), restore it via the survival-safe moveTo/addGroup pattern (the
 *      same restore() HostOp the tray-chip uses; NEVER removePanel to collapse).
 *   3. KEYBOARD COMPOSITION — if keyboard focus-mode is open:
 *        - target == current focused pane → keep keyboard mode; just ensure focus.
 *        - target != current focused pane → exit keyboard focus-mode first
 *          (preserves any manual maximize; exitOwned only exits what focus-mode
 *          owns), then focus the target.
 *   4. FOCUS the target via Dockview panel.api.setActive() (through hostOps).
 *
 * No-op when no pane needs you (the button is hidden in that case anyway).
 */
export function next(): void {
  const target = nextTarget();
  if (!target) return;

  // Capture the PRE-switch focusedId BEFORE any state mutation. On a cross-ws
  // NEXT, setActiveWorkspace(target.wsId) SYNCHRONOUSLY re-projects focusedId()
  // to the target (store.ts setActiveWorkspace → hostController.syncAll →
  // setFocused on workspace activation), so by the time the keyboard cross-pane
  // rule below runs the live focusedId() has already flipped to target.paneId
  // and the rule would wrongly conclude "same pane" (never firing
  // exitKeyboardFocus). Reading the captured pre-switch id makes the rule see
  // the genuine cross-pane case → exitKeyboardFocus() fires before
  // onWorkspaceActivated (keyboardFocus.ts) re-points the owned maximize.
  const preFocusedId = focusedId();

  // 1. Cross-workspace: activate the target's workspace first (survival-safe).
  if (target.wsId !== activeWorkspaceId()) {
    setActiveWorkspace(target.wsId);
  }

  // 2. Restore from tray if the target is collapsed (floating group). Use the
  //    target workspace's api (now active after the switch above, or already
  //    active) to inspect location; restore via hostOps() which resolves the
  //    active workspace's facet (the target's). Survival-safe: restore() uses
  //    moveTo + addGroup, NEVER removePanel.
  const api = workspaceApiFor(target.wsId);
  const panel = api?.getPanel(target.paneId);
  if (panel && panel.group.api.location.type === "floating") {
    hostOps()?.restore?.(target.paneId);
  }

  // 3. Keyboard focus-mode composition (debate ownership rule, operator-
  //    confirmed). A target switch mid-keyboard keeps keyboard mode ONLY if the
  //    new target is the SAME active pane; otherwise dismiss the keyboard first.
  //    Evaluate against the PRE-switch focusedId (captured at the top): the live
  //    focusedId() has already been re-projected to target.paneId by a cross-ws
  //    switch in step 1, which would mask the cross-pane case.
  if (isKeyboardOpen() && target.paneId !== preFocusedId) {
    // Cross-pane target: exit keyboard focus-mode. exitKeyboardFocus() restores
    // the host root height + exits ONLY the maximize focus-mode owns — a user's
    // manual maximize is never clobbered.
    exitKeyboardFocus();
  }

  // 4. Focus the target. After a cross-workspace switch + restore, hostOps()
  //    resolves the target workspace's facet; focusPane calls setActive(). For
  //    the same-pane-keyboard case this re-asserts focus without exiting the
  //    keyboard maximize (the rule above skipped the exit).
  hostOps()?.focusPane?.(target.paneId);
}
