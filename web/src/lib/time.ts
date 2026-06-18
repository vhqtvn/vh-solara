// Relative-time formatting + a single global refresh manager. The <RelTime>
// component (components/RelTime.tsx) is the only consumer; it registers itself
// here so ALL relative-time labels are driven by one shared interval (not one
// timer each) and re-render as time passes — they used to be computed once at
// mount and go stale.
//
// Hybrid visibility gating (cheap at small scale, scalable at large):
//   - Below VIS_THRESHOLD registered labels: refresh every label each tick —
//     visibility checks aren't worth their cost.
//   - At/above it: only refresh labels currently on screen, tracked cheaply via
//     a single IntersectionObserver (native, batched, fires only on change).

// "now" / "5m" / "2h" / "3d" / "2mo" — compact, for the session tree and lists.
export function formatShort(ms: number | undefined, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

// "5s ago" / "5m ago" / "2h ago" / "3d ago" — verbose, for message metadata.
export function formatAgo(ms: number | undefined, now: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// "5s" / "5m" / "2h 3m" / "3d 4h" — a span between two timestamps, for "ran for".
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

interface Entry {
  refresh: () => void;
  el?: HTMLElement;
}

const TICK_MS = 15_000;
// Below this many live labels, skip visibility work and just refresh them all.
const VIS_THRESHOLD = 30;

const entries = new Set<Entry>();
let timer: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;
// Off-screen elements. Default (unobserved/unknown) => visible, so we never
// skip a label we haven't classified yet.
const hidden = new WeakSet<HTMLElement>();

function ensureObserver() {
  if (observer || typeof IntersectionObserver === "undefined") return;
  observer = new IntersectionObserver((records) => {
    for (const r of records) {
      if (r.isIntersecting) hidden.delete(r.target as HTMLElement);
      else hidden.add(r.target as HTMLElement);
    }
  });
  // Observe everything already registered now that the observer exists.
  for (const e of entries) if (e.el) observer.observe(e.el);
}

function tick() {
  const gate = entries.size >= VIS_THRESHOLD && !!observer;
  for (const e of entries) {
    if (gate && e.el && hidden.has(e.el)) continue;
    e.refresh();
  }
}

// Register a label's refresh callback and (after mount) its element. Returns an
// unregister function. The shared interval runs only while ≥1 label is live.
export function registerRelTime(refresh: () => void, getEl: () => HTMLElement | undefined): () => void {
  const entry: Entry = { refresh };
  entries.add(entry);
  if (timer === undefined) timer = setInterval(tick, TICK_MS);

  // Grab the element after the current render flush, then start observing once
  // we've crossed the threshold where visibility gating pays off.
  queueMicrotask(() => {
    entry.el = getEl();
    if (entries.size >= VIS_THRESHOLD) ensureObserver();
    if (observer && entry.el) observer.observe(entry.el);
  });

  return () => {
    entries.delete(entry);
    if (observer && entry.el) {
      observer.unobserve(entry.el);
      hidden.delete(entry.el);
    }
    if (entries.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
