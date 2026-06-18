// Client for the daemon's git write endpoints (stage/unstage/discard/commit/
// push). Scoped to the active project dir; writes need an explicit project
// (the daemon won't guess a cwd).
import { projectDir } from "./sync";

export interface GitFile {
  file: string;
  index: string; // staged status (X) — " " none, "?" untracked
  worktree: string; // unstaged status (Y)
}
export interface GitStatus {
  branch: string;
  files: GitFile[];
}

const dirParam = () => `?dir=${encodeURIComponent(projectDir())}`;

export async function gitStatus(): Promise<GitStatus | null> {
  try {
    const res = await fetch("/vh/git/status" + dirParam());
    if (!res.ok) return null;
    return (await res.json()) as GitStatus;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; output?: string }> {
  try {
    const res = await fetch(path + dirParam(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: true, output: j.output };
    }
    return { ok: false, error: (await res.text().catch(() => "")) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export const gitStage = (files?: string[]) => post("/vh/git/stage", files?.length ? { files } : { all: true });
export const gitUnstage = (files?: string[]) => post("/vh/git/unstage", files?.length ? { files } : { all: true });
export const gitDiscard = (files: string[]) => post("/vh/git/discard", { files });
export const gitCommit = (message: string) => post("/vh/git/commit", { message });
export const gitPush = () => post("/vh/git/push", {});

// A file is staged if its index status is set (not unmodified/untracked).
export const isStaged = (f: GitFile) => f.index !== " " && f.index !== "?";
export const isUntracked = (f: GitFile) => f.index === "?";
