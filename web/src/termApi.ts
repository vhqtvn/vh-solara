// Terminal session management (Settings → Terminals): list live sessions with a
// preview, and kill them. Distinct from the per-pane WebSocket.
import { log } from "./lib/log";

export interface TermInfo {
  dir: string;
  id: string;
  session?: string;
  title?: string;
  clients: number;
  cols: number;
  rows: number;
  idleSec: number;
  preview: string;
}

// List terminals; pass a dir to scope to one project (the dock tab strip), omit
// for all projects (the Settings tab).
export async function listTerms(dir?: string): Promise<TermInfo[]> {
  try {
    const q = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    const r = await fetch(`/vh/term/list${q}`);
    if (!r.ok) log.debug("term", `list → HTTP ${r.status}`);
    return r.ok ? ((await r.json()) as TermInfo[]) : [];
  } catch (e) {
    log.debug("term", "list failed", e); // polled — keep at debug to avoid spam
    return [];
  }
}

// Kill a terminal's shell. id defaults server-side to "shared". The CSRF header
// is required for mutating /vh/* POSTs (csrfGuard) — without it the server 403s.
export async function killTerm(dir: string, id?: string): Promise<boolean> {
  try {
    const r = await fetch("/vh/term/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ dir, id }),
    });
    if (!r.ok) log.warn("term", `kill → HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    log.warn("term", "kill failed", e);
    return false;
  }
}
