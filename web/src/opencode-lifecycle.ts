// OpenCode lifecycle client + store.
//
// The vh-solara worker exposes three endpoints that describe the OpenCode
// process it drives (independent of whether that process is reachable over the
// tunnel):
//
//   GET  /vh/opencode/status    → oclife.Snapshot   (503 if lifecycle not wired)
//   GET  /vh/opencode/logs?max  → text/plain tail   (501 for external topology)
//   POST /vh/opencode/restart   → post-restart Snapshot (405 external; CSRF-gated)
//
// This module mirrors web/src/managed.ts: a SolidJS signal holds the latest
// Snapshot, refreshOpenCodeLifecycle/restartOpenCode/fetchLogs perform the HTTP,
// and start/stopLifecyclePolling drive an adaptive poll (faster while starting
// or failed). The X-VH-CSRF header is added automatically by installCsrf()
// (web/src/csrf.ts), so the restart POST is compliant without extra setup here.
//
// IMPORTANT — worker-SSE connection state (ConnectionToast) is NOT OpenCode
// health. A live stream only means the vh-solara worker is reachable; OpenCode
// itself may still be starting/failed. This store is the single source of truth
// for the latter.
import { createSignal } from "solid-js";

export type Topology = "owned" | "detached" | "external";
export type LifecycleState =
  | "starting"
  | "ready"
  | "failed"
  | "stopped"
  | "unknown";
export type DiagnosticCompleteness = "complete" | "partial" | "unavailable";

export interface Capabilities {
  can_restart: boolean;
  has_process_output: boolean;
  has_log_tail: boolean;
  has_exit_status: boolean;
}

export interface Snapshot {
  topology: Topology;
  state: LifecycleState;
  state_changed_at: string;
  opencode_url?: string;
  failure_summary?: string;
  exit_code?: number | null;
  capabilities: Capabilities;
  diagnostic_completeness: DiagnosticCompleteness;
}

// A neutral "unknown" shape for 503 (lifecycle not wired) and network errors.
// Used so callers can branch on a Snapshot without a null check. The separate
// `lifecycleAvailable` signal distinguishes "the daemon manages OC but can't
// tell its state" (200 + state=unknown) from "the daemon has no lifecycle
// surface at all" (503) — the latter defers to the legacy generic behavior so an
// older daemon never flashes a permanent "status unknown" panel.
export const UNKNOWN_SNAPSHOT: Snapshot = {
  topology: "external",
  state: "unknown",
  state_changed_at: "",
  capabilities: {
    can_restart: false,
    has_process_output: false,
    has_log_tail: false,
    has_exit_status: false,
  },
  diagnostic_completeness: "unavailable",
};

const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
// True once a 200 has been seen. False on 503 (lifecycle not wired) and before
// the first poll resolves. The UI uses this to avoid surfacing a permanent
// "unknown" banner on daemons that don't expose the lifecycle endpoints.
const [lifecycleAvailable, setLifecycleAvailable] = createSignal(false);
export { snapshot, lifecycleAvailable };

// Fetch the current lifecycle snapshot. A 503 means the worker's lifecycle
// surface isn't wired (older daemon / non-managing topology): record an unknown
// shape but mark lifecycleAvailable=false so the UI falls back to the legacy
// generic behavior instead of a permanent "status unknown" panel.
export async function refreshOpenCodeLifecycle(): Promise<void> {
  try {
    const res = await fetch("/vh/opencode/status");
    if (res.status === 503) {
      setLifecycleAvailable(false);
      setSnapshot({ ...UNKNOWN_SNAPSHOT, state_changed_at: nowIso() });
      return;
    }
    if (!res.ok) {
      // Any other error: treat like not-wired rather than alarming the user.
      setLifecycleAvailable(false);
      setSnapshot({ ...UNKNOWN_SNAPSHOT, state_changed_at: nowIso() });
      return;
    }
    const snap = (await res.json()) as Snapshot;
    setLifecycleAvailable(true);
    setSnapshot(snap);
  } catch {
    // Network failure (offline / worker unreachable): leave the existing
    // snapshot intact so a transient blip doesn't flap the UI. If there is no
    // prior snapshot, mark unavailable so the panel stays quiet rather than
    // racing to "unknown" on cold start.
    if (snapshot() === null) {
      setLifecycleAvailable(false);
      setSnapshot({ ...UNKNOWN_SNAPSHOT, state_changed_at: nowIso() });
    }
  }
}

// POST /vh/opencode/restart and adopt the returned post-restart snapshot. The
// X-VH-CSRF header is added by installCsrf(); nothing to do here. Returns true
// on success, false on any failure (caller surfaces its own message). Named
// `restartOpenCode` (not bare `restart`) to avoid confusion with the older
// /vh/restart-opencode flow used by the RestartOpenCode component.
export async function restartOpenCode(): Promise<boolean> {
  try {
    const res = await fetch("/vh/opencode/restart", { method: "POST" });
    if (!res.ok) return false;
    const snap = (await res.json()) as Snapshot;
    setLifecycleAvailable(true);
    setSnapshot(snap);
    return true;
  } catch {
    return false;
  }
}

export interface LogsResult {
  ok: boolean;
  text: string;
  status: number;
}

// Fetch the bounded ring tail. max defaults to 8192 (server cap 65536). 501 =
// external topology (no logs): returned as ok:false with the status so the UI
// can show "Logs not available for this topology".
export async function fetchLogs(max = 8192): Promise<LogsResult> {
  try {
    const res = await fetch(`/vh/opencode/logs?max=${max}`);
    if (!res.ok) return { ok: false, text: "", status: res.status };
    const text = await res.text();
    return { ok: true, text, status: 200 };
  } catch {
    return { ok: false, text: "", status: 0 };
  }
}

// ── Adaptive polling ──────────────────────────────────────────────────────
// Normal cadence 5s; faster (2s) while starting or failed so a readiness flip
// or a fresh failure surfaces quickly. Self-rescheduling setTimeout chain (not
// setInterval) so each delay adapts to the latest state.
const NORMAL_INTERVAL_MS = 5000;
const FAST_INTERVAL_MS = 2000;

function nextInterval(): number {
  const st = snapshot()?.state;
  if (st === "starting" || st === "failed") return FAST_INTERVAL_MS;
  return NORMAL_INTERVAL_MS;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;

export function startLifecyclePolling(): void {
  if (pollTimer !== undefined) return;
  void refreshOpenCodeLifecycle();
  const tick = (): void => {
    void refreshOpenCodeLifecycle().finally(() => {
      pollTimer = setTimeout(tick, nextInterval());
    });
  };
  pollTimer = setTimeout(tick, nextInterval());
}

export function stopLifecyclePolling(): void {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}
