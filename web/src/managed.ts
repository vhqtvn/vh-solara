// Repo-declared managed projects: when a project dir carries a
// .vh-solara/project.jsonc, the daemon discovers it, prompts for trust on
// first open, then runs the declared processes + registers their views. This
// client mirrors the daemon's /vh/managed + /vh/trust surface (see
// pkg/web/managed.go) for the trust-review card and the processes panel.
import { createSignal } from "solid-js";
import { projectDir } from "./sync";

export type ManagedState = "none" | "awaiting-trust" | "changed" | "trusted";
export type ProcStatus = "stopped" | "starting" | "ready" | "unhealthy" | "failed";

export interface ManagedReviewProc {
  id: string;
  command: string;
  cwd: string;
  env_keys: string[];
  restart: string;
}
export interface ManagedReviewView {
  id: string;
  title: string;
  path_prefix: string;
  upstream: string;
  depends_on: string;
}
export interface ManagedReview {
  config_json: string;
  processes: ManagedReviewProc[];
  views: ManagedReviewView[];
}
export interface ManagedProc {
  dir: string;
  id: string;
  status: ProcStatus;
  pid: number;
  command: string;
  restart: string;
  started_at: string;
  ready_at: string;
  exit_code: number;
  restarts: number;
}
export interface ManagedViewStatus {
  id: string;
  path_prefix: string;
  status: string; // registered | prefix-conflict | pending (not trusted yet)
}
export interface ManagedProject {
  dir: string;
  state: ManagedState;
  config_hash?: string;
  review?: ManagedReview;
  processes: ManagedProc[];
  views: ManagedViewStatus[];
}

const [managed, setManaged] = createSignal<ManagedProject | null>(null);
export { managed };

const dirParam = (dir: string) => `?dir=${encodeURIComponent(dir)}`;

// Fetch the active project's managed state. State "none" (no config) is a
// normal result — we clear the signal so the UI shows nothing.
export async function refreshManaged() {
  const dir = projectDir();
  try {
    const res = await fetch("/vh/managed" + dirParam(dir));
    if (!res.ok) {
      setManaged(null);
      return;
    }
    const p = (await res.json()) as ManagedProject;
    setManaged(p && p.state !== "none" ? p : null);
  } catch {
    /* offline — leave as-is */
  }
}

// Approve (or re-approve) the checked-in config for this project. The daemon
// starts the declared processes + registers views on success.
export async function grantTrust(): Promise<boolean> {
  const dir = projectDir();
  try {
    const res = await fetch("/vh/trust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    if (!res.ok) return false;
    await refreshManaged();
    return true;
  } catch {
    return false;
  }
}

// Start / stop / restart a declared process.
export async function controlProc(id: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  const dir = projectDir();
  try {
    const res = await fetch("/vh/managed" + dirParam(dir) + `&id=${encodeURIComponent(id)}&action=${action}`, {
      method: "POST",
    });
    if (!res.ok) return false;
    await refreshManaged();
    return true;
  } catch {
    return false;
  }
}

// Tail a process's captured log ring.
export async function procLogs(id: string, max = 16384): Promise<string> {
  const dir = projectDir();
  try {
    const res = await fetch("/vh/managed" + dirParam(dir) + `&id=${encodeURIComponent(id)}&logs=1&max=${max}`);
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}
