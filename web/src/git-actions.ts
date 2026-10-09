// Client for the daemon's git write endpoints (stage/unstage/discard/commit/
// push). Scoped to the active project dir; writes need an explicit project
// (the daemon won't guess a cwd).
//
// Commit + push carry the send-net-resilience slice-6 honesty guards
// (debate-2 Q3). The daemon's git handlers are argv-only with NO receipt or
// key (research-packet-2 §B3), and a commit retry self-protects ONLY while
// the index stays empty — restaging between a landed-but-unconfirmed commit
// and a retry mints a SECOND distinct commit. Push retry is benign
// ("Everything up-to-date"). So the FE treats commit/push like the fork guard
// treats a non-idempotent upstream (slice 4c pattern):
//   1. SINGLE-FLIGHT per repo: a synchronous latch (set before any await,
//      cleared in finally) shared by the commit/push pair — no concurrent
//      double-fire of either gesture, across remounts and surfaces.
//   2. BOUND: AbortController per POST (see the constants below).
//   3. HONEST OUTCOME-UNKNOWN: timeout / network / 5xx (incl. the daemon's
//      runGit kill) → {outcome:"uncertain"} — the mutation may have landed.
//      NEVER auto-retry; the UI wards the commit button and points at
//      status+log reconciliation. A definitive 4xx stays a definitive error
//      (the server answered; no mutation happened) — no manufactured
//      ambiguity, same adjudication as 4c.
//
// Stage/unstage/discard keep the legacy bare post() shape: they are
// retry-benign tree edits already serialized per-surface by GitView's busy
// flag, and the mission explicitly rejects widening this slice beyond the
// commit/push pair.
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
// One row of the reconciliation log (GET /vh/git/log): enough to SEE whether
// an unconfirmed commit landed (hash + subject + date, newest first).
export interface GitLogEntry {
  hash: string;
  subject: string;
  date: string;
}

const dirQuery = () => `dir=${encodeURIComponent(projectDir())}`;

// --- strict-shape discriminators: container AND element level ---------------
//
// The reconcile ward lifts only on reads whose evidence was ACTUALLY read:
// a schema-malformed 200 must classify as unreadable (null), never as a
// "successful" read. Gate rounds 2–3 closed the CONTAINER gates (string
// branch + files array / commits array); gate round 4 (tier1_b:F1) closes
// the theme at the ELEMENT level — the container gates alone let garbage
// ARRAY ELEMENTS ({files:[{}]}, {commits:[{}]}) ride a well-shaped container
// and read as "successful", clearing a commit-uncertain ward on evidence
// never actually read. Strict shape now holds at BOTH levels: any malformed
// element ANYWHERE in the array makes the whole read null (unreadable) —
// the same semantics as the container gates. There is no deeper layer to
// peel: the element members below are the leaf fields of the wire types.

// A GitFile element is well-formed iff its required members are strings
// (per the GitFile type: file/index/worktree).
function isGitFile(v: unknown): v is GitFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.file === "string" && typeof f.index === "string" && typeof f.worktree === "string";
}

// A GitLogEntry element is well-formed iff its required members are strings
// (per the GitLogEntry type: hash/subject/date).
function isGitLogEntry(v: unknown): v is GitLogEntry {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.hash === "string" && typeof c.subject === "string" && typeof c.date === "string";
}

// Working-tree status (GET /vh/git/status). The FAILURE SURFACE is
// load-bearing exactly like gitLog's below (slice-6 reconcile ward):
// reconcile's ward clears on a NON-NULL status read, so a failed read must
// be distinguishable from a genuine result. null = the read FAILED (fetch
// error, non-OK, or a schema-malformed 200 — gate rounds 2–4, the strict
// shape at container AND element level): only a body with the STRICT status
// shape — a string `branch` + an array `files` (container) whose EVERY
// element satisfies the GitFile member shape (element) — counts as a
// healthy read. A 200 failing either level is unreadable, never a
// "successful" status read that could lift the uncertain-commit ward
// without a valid reconciliation.
export async function gitStatus(): Promise<GitStatus | null> {
  try {
    const res = await fetch(`/vh/git/status?${dirQuery()}`);
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<GitStatus>;
    return typeof j.branch === "string" && Array.isArray(j.files) && j.files.every(isGitFile) ? (j as GitStatus) : null;
  } catch {
    return null;
  }
}

// Recent commits for the reconciliation surface. Read-only, but the FAILURE
// SURFACE IS LOAD-BEARING (slice-6 reconcile ward): the uncertain-commit ward
// lifts only on a SUCCESSFUL status+log reconcile, so a failed read must be
// distinguishable from a genuine result. null = the read FAILED (fetch error,
// non-OK, or a schema-malformed 200 — strict shape at container AND element
// level: the body must carry an explicitly-present commits ARRAY whose EVERY
// element satisfies the GitLogEntry member shape); [] = a HEALTHY read of an
// explicitly-present empty log (e.g. an unborn repo) — never conflate them,
// or a broken link masquerades as "no commits".
export async function gitLog(n = 5): Promise<GitLogEntry[] | null> {
  try {
    const res = await fetch(`/vh/git/log?n=${n}&${dirQuery()}`);
    if (!res.ok) return null;
    const j = (await res.json()) as { commits?: GitLogEntry[] };
    return Array.isArray(j.commits) && j.commits.every(isGitLogEntry) ? j.commits : null;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; output?: string }> {
  try {
    const res = await fetch(`/${path}?${dirQuery()}`, {
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

export const gitStage = (files?: string[]) => post("vh/git/stage", files?.length ? { files } : { all: true });
export const gitUnstage = (files?: string[]) => post("vh/git/unstage", files?.length ? { files } : { all: true });
export const gitDiscard = (files: string[]) => post("vh/git/discard", { files });

// --- slice-6 guarded mutations (commit + push only) ------------------------
//
// Outcome classification at the FE vantage (mirrors createMessageActions'
// fork guard):
//   - "ok"        2xx — the daemon ran git to completion and it succeeded.
//   - "error"     definitive 4xx — the server ANSWERED (bad request, no dir,
//                 empty message): no mutation happened.
//   - "uncertain" timeout / network error / any 5xx — the POST may have been
//                 applied (the daemon's 502 covers both "git ran and failed"
//                 and "git was killed"; its 504 names the push bound). The
//                 daemon's own output rides along in `detail` so the operator
//                 sees git's message inside the honest-unknown surface.
//   - "busy"      the per-repo single-flight latch is held — a silent no-op
//                 for the double-fire the caller's disabled state already
//                 wards in-panel; this covers remounts/second surfaces.

export type GitMutationResult =
  | { outcome: "ok"; output?: string }
  | { outcome: "error"; error: string }
  | { outcome: "uncertain"; detail: string }
  | { outcome: "busy" };

// COMMIT_FETCH_TIMEOUT_MS = 45s: the daemon caps `git commit` at 30s (a
// commit is a fast LOCAL operation — writing objects + a ref update; only
// pathological hooks/gc could make it slow, and killing it leaves the index
// staged, i.e. recoverable, not duplicated). The FE bound sits 15s ABOVE the
// daemon cap so the daemon's classified answer (including its kill) wins
// whenever it can still arrive; if the FE bound fires instead, the response
// was lost on the link → uncertain.
const COMMIT_FETCH_TIMEOUT_MS = 45_000;

// PUSH_FETCH_CEILING_MS = 630s: a pure safety CEILING, not the push bound —
// the bound is the daemon's per-op push timeout (default 300s, configurable
// via VH_GIT_PUSH_TIMEOUT_SECS). Pushes move real payloads over real links
// (the program exists because operators drive weak links); 300s covers
// multi-hundred-MB pushes on decent links and tens-of-MB on very slow ones,
// while still bounding a hung socket. The FE ceiling exists so a dead tunnel
// cannot pin the busy state forever; it deliberately sits ABOVE the daemon's
// default so the daemon's own classified outcome (200 / 502 / 504) wins.
const PUSH_FETCH_CEILING_MS = 630_000;

// Per-repo single-flight for the commit/push pair (the risky pair — never
// concurrent with each other either). Keyed by projectDir.
const gitMutationInFlight = new Set<string>();

async function postGuarded(
  path: string,
  body: unknown,
  timeoutMs: number,
  opLabel: string,
): Promise<GitMutationResult> {
  const dir = projectDir();
  if (gitMutationInFlight.has(dir)) return { outcome: "busy" };
  gitMutationInFlight.add(dir);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/${path}?${dirQuery()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return { outcome: "ok", output: j.output };
    }
    const text = (await res.text().catch(() => "")) || `HTTP ${res.status}`;
    if (res.status >= 500) {
      return { outcome: "uncertain", detail: `HTTP ${res.status}: ${text.split("\n")[0].slice(0, 200)}` };
    }
    return { outcome: "error", error: text.split("\n")[0] };
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    return {
      outcome: "uncertain",
      detail: aborted
        ? `${opLabel}: no confirmation within ${timeoutMs / 1000}s`
        : `${opLabel}: request failed (${String(e)})`,
    };
  } finally {
    clearTimeout(timer);
    gitMutationInFlight.delete(dir);
  }
}

export const gitCommit = (message: string) => postGuarded("vh/git/commit", { message }, COMMIT_FETCH_TIMEOUT_MS, "commit");
export const gitPush = () => postGuarded("vh/git/push", {}, PUSH_FETCH_CEILING_MS, "push");

// A file is staged if its index status is set (not unmodified/untracked).
export const isStaged = (f: GitFile) => f.index !== " " && f.index !== "?";
export const isUntracked = (f: GitFile) => f.index === "?";
