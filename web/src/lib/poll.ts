// startPoll — a visibility-aware, single-flight polling loop.
//
// Replaces bare `setInterval(fetchX, N)` pollers. A fixed interval keeps firing
// while earlier requests are still in flight, so on a slow link (controller →
// yamux tunnel → worker) requests stack up per pane and amplify the very
// congestion that made them slow. This loop instead:
//
//   - is SINGLE-FLIGHT: the next run is scheduled only after the current one
//     settles, so at most one request per loop is ever outstanding;
//   - ADAPTS to latency: the next delay is at least the last run's duration;
//   - BACKS OFF on failure (a throw, or the task resolving `false`): the delay
//     doubles up to maxBackoffMs, and resets on the next success;
//   - PAUSES while the pane is not visible (paneVisibility: document hidden, or
//     the host shell hid this pane) and runs once on becoming visible again if
//     the last run is older than the interval.
import { isPaneVisible, onPaneVisibilityChange } from "../paneVisibility";

export interface PollOptions {
  /** Base delay between the end of one run and the start of the next. */
  intervalMs: number;
  /** Failure backoff ceiling (default 60s). */
  maxBackoffMs?: number;
  /** Run once immediately (default true; subject to visibility). */
  immediate?: boolean;
  /** Visibility source (default: paneVisibility). Injectable for tests. */
  isVisible?: () => boolean;
  onVisibilityChange?: (l: (visible: boolean) => void) => () => void;
}

/** A task resolving `false` counts as a failure (backoff); anything else is success. */
export type PollTask = () => Promise<unknown> | unknown;

/** Start a poll loop. Returns a stop function (idempotent). */
export function startPoll(task: PollTask, opts: PollOptions): () => void {
  const base = opts.intervalMs;
  const maxBackoff = Math.max(base, opts.maxBackoffMs ?? 60_000);
  const isVisible = opts.isVisible ?? isPaneVisible;
  const subscribe = opts.onVisibilityChange ?? onPaneVisibilityChange;

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = base;
  let lastEnd = 0; // 0 = never ran

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (ms: number) => {
    clear();
    if (stopped || !isVisible()) return; // resumed by the visibility listener
    timer = setTimeout(run, ms);
  };

  async function run(): Promise<void> {
    timer = undefined;
    if (stopped || inFlight) return;
    if (!isVisible()) return;
    inFlight = true;
    const start = Date.now();
    let ok = true;
    try {
      ok = (await task()) !== false;
    } catch {
      ok = false;
    }
    inFlight = false;
    if (stopped) return;
    const end = Date.now();
    lastEnd = end;
    const took = end - start;
    delay = ok ? Math.max(base, took) : Math.min(maxBackoff, Math.max(delay, took) * 2);
    schedule(delay);
  }

  const unsubscribe = subscribe((visible) => {
    if (stopped) return;
    if (!visible) {
      clear();
      return;
    }
    if (inFlight || timer !== undefined) return;
    const since = lastEnd === 0 ? Infinity : Date.now() - lastEnd;
    if (since >= delay) void run();
    else schedule(delay - since);
  });

  if (opts.immediate === false) schedule(delay);
  else void run();

  return () => {
    if (stopped) return;
    stopped = true;
    clear();
    unsubscribe();
  };
}
