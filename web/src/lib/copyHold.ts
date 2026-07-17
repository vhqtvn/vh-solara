// Classify a press as a tap vs a long-press ("hold") by elapsed wall-clock
// time between pointerdown and the click that follows.
//
// This mirrors the paste button's tap-vs-hold classifier (ChatView.tsx): a
// previous timer+flag scheme misclassified holds as taps when main-thread jank
// stalled the event loop past 450ms (CI load, throttled devices), because the
// timer callback raced the click handler. Comparing elapsed wall-clock at click
// time is load-independent and deterministic. The caller MUST record
// pointerdown's Date.now() and pass it as downAt; a click always follows its
// pointerdown in the same gesture, so downAt is a real timestamp at classify
// time.
//
// The 450ms threshold is shared with the paste button on purpose so the two
// hold affordances feel identical across the app.

export const HOLD_THRESHOLD_MS = 450;

export type HoldClassification = "tap" | "hold";

// Classify a press as tap vs hold by elapsed wall-clock time between
// pointerdown and the click that follows.
//
// Keyboard sentinel: when no pointerdown precedes the click — keyboard
// activation (Enter or Space on a focused Copy button) or any programmatic
// `.click()` — the caller's `downAt` stays at its initial `0`, because
// `onPointerDown` never ran for that gesture. (Date.now() never returns 0 in
// practice, so `0` is a reliable sentinel.) Keyboard/programmatic activation
// carries no hold intent, and the module-level precondition "a click always
// follows its pointerdown" does not hold for it, so classify it as the
// least-surprising default — `"tap"` (text-only) — rather than running the
// elapsed comparison, which would otherwise always yield `"hold"` because
// `Date.now() - 0 >= 450` is always true.
export function classifyHold(
  downAt: number,
  nowMs: number,
): HoldClassification {
  if (downAt === 0) return "tap";
  return nowMs - downAt >= HOLD_THRESHOLD_MS ? "hold" : "tap";
}

// Dedupe guard for the Android-Chrome touch double-fire: a touch long-press can
// synthesize BOTH a contextmenu event AND a subsequent click. The Copy button
// copies thinking in onContextMenu, so a hold-classified click that follows
// would copy thinking a second time. Skip the click's copy only when a
// contextmenu already copied thinking (flag set) AND the click classifies as a
// hold — the exact double-fire shape. A following tap is never suppressed.
//
// This is NOT the abandoned timer-race scheme: the flag is set synchronously
// inside onContextMenu, which the browser guarantees fires before the
// synthesized click in the same gesture, so the ordering is deterministic.
export function shouldSkipAfterContextmenu(
  prevContextmenuCopy: boolean,
  classification: HoldClassification,
): boolean {
  return prevContextmenuCopy && classification === "hold";
}
