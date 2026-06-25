// Workspace VCS (git) access via the daemon's /oc passthrough to OpenCode's
// /vcs endpoints. The daemon serves one workspace, so this reflects its tree.
import { log } from "./lib/log";

export interface VcsInfo {
  branch?: string;
  default_branch?: string;
}

export interface FileDiff {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

export type DiffMode = "git" | "branch";

async function getJSON<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      log.warn("vcs", `${url} → HTTP ${r.status}`);
      return fallback;
    }
    return (await r.json()) as T;
  } catch (e) {
    log.warn("vcs", `${url} failed`, e);
    return fallback;
  }
}

export function fetchVcsInfo(): Promise<VcsInfo> {
  return getJSON<VcsInfo>("/oc/vcs", {});
}

export function fetchVcsDiff(mode: DiffMode): Promise<FileDiff[]> {
  return getJSON<FileDiff[]>(`/oc/vcs/diff?mode=${mode}`, []);
}
