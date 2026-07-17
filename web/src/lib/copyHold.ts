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

export function classifyHold(
  downAt: number,
  nowMs: number,
): HoldClassification {
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
