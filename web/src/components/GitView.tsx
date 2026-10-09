import { createResource, createSignal, For, Show } from "solid-js";
import { type DiffMode, type FileDiff, fetchVcsDiff, fetchVcsInfo } from "../git";
import { renderPatch } from "../render";
import { loadVersioned, saveVersioned } from "../lib/store";
import { projectDir } from "../sync";
import { type GitFile, type GitLogEntry, gitCommit, gitDiscard, gitLog, gitPush, gitStage, gitStatus, gitUnstage, isStaged, isUntracked } from "../git-actions";
import { pushNotification } from "../notify";
import { bindBackDismiss } from "../lib/backStack";
import FileBadge from "./FileBadge";
import Icon from "./Icon";
import "./GitView.css";

type DiffLayout = "unified" | "split";
const LS_LAYOUT = "vh.diff.layout.v1";
const [layout, setLayoutSig] = createSignal<DiffLayout>(
  loadVersioned<DiffLayout>(LS_LAYOUT, 1, "unified", (o) => (o === "split" ? "split" : "unified")),
);
function setLayout(v: DiffLayout) {
  setLayoutSig(v);
  saveVersioned(LS_LAYOUT, 1, v);
}

// Uncertain git-mutation outcome (send-net-resilience slice 6, debate-2 Q3).
// Module-level (like `layout` above) so the ward survives view switches and
// remounts within the SPA session — PER-REPO, keyed by the directory the
// request was STARTED against (gate review A-F1/A-F2 + B-F1/B-F2): a project
// switch mid-flight must ward the repo the mutation actually ran against,
// never the repo the operator happens to view when the outcome resolves.
// An uncertain COMMIT blocks that repo's commit button until reconciled (the
// daemon has no receipt — restaging between a landed-but-unconfirmed commit
// and a blind retry mints a second commit); an uncertain PUSH is
// honest-but-benign (a retry re-pushes or reports "up-to-date") and wards
// nothing.
export interface GitUncertain {
  dir: string;
  op: "commit" | "push";
  detail: string;
}
const [gitUncertainByDir, setGitUncertainByDir] = createSignal<Readonly<Record<string, GitUncertain>>>({});

// Write one repo's uncertain outcome. Within a SINGLE repo the commit ward is
// the stronger state and no write path may weaken it: a push-uncertain
// landing on an ACTIVE commit-uncertain is a no-op (the commit ward exits
// ONLY via reconcile's both-reads-success gate, r1-r3 — a push going
// uncertain must not re-enable the commit button with staged files + the
// retained message sitting there). A commit-uncertain always (re)writes its
// repo's entry; a push-uncertain rewrites only when no commit ward is held.
// Returns whether the repo's displayed state CHANGED, so the caller resets
// per-banner render state (the failed-reconcile line, A-F4) only for a
// FRESH banner.
export function setGitUncertain(u: GitUncertain): boolean {
  const prev = gitUncertainByDir()[u.dir];
  if (prev?.op === "commit" && u.op === "push") return false;
  setGitUncertainByDir((m) => ({ ...m, [u.dir]: u }));
  return true;
}

// Lift ONE repo's ward — reconcile's exclusive exit (both reads succeeded).
export function clearGitUncertainDir(dir: string) {
  setGitUncertainByDir((m) => {
    if (!(dir in m)) return m;
    const next: Record<string, GitUncertain> = { ...m };
    delete next[dir];
    return next;
  });
}

// Reset every repo's uncertain state (test seam).
export function clearGitUncertain() {
  setGitUncertainByDir({});
}

function FilePatch(props: { file: FileDiff }) {
  const [open, setOpen] = createSignal(false);
  // Re-render when either the file opens or the layout (unified/split) changes.
  const [html] = createResource(
    () => (open() ? { patch: props.file.patch || "", mode: layout() } : null),
    (r) => renderPatch(r.patch, r.mode),
  );
  return (
    <div class="gitfile">
      <button type="button" class="gitfile-head" onClick={() => setOpen((v) => !v)}>
        <span class="gitfile-status" classList={{ [props.file.status || "modified"]: true }}>
          {(props.file.status || "modified")[0].toUpperCase()}
        </span>
        <span class="gitfile-name">
          <FileBadge path={props.file.file} /> {props.file.file}
        </span>
        <span class="gitfile-counts">
          <span class="adds">+{props.file.additions}</span>
          <span class="dels">-{props.file.deletions}</span>
        </span>
      </button>
      <Show when={open()}>
        <Show when={html()} fallback={<div class="md-raw gitfile-loading">loading…</div>}>
          <div class="gitfile-diff" innerHTML={html()!} />
        </Show>
      </Show>
    </div>
  );
}

// Staging + commit panel. Git writes need a real project dir, so this shows
// only when one is active; the daemon shells git there.
function StagingPanel(props: { onChanged: () => void }) {
  const [status, { refetch }] = createResource(() => projectDir(), (dir) => (dir ? gitStatus() : Promise.resolve(null)));
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // Which guarded mutation is running ("commit" | "push" | null) — drives the
  // visible running labels (a push may legitimately run for minutes under the
  // daemon's per-op push bound, so "Pushing…" is not cosmetic).
  const [runningOp, setRunningOp] = createSignal<"commit" | "push" | null>(null);
  // Reconciliation log rows for the uncertain banner. logLoaded means the
  // LAST read SUCCEEDED (only then may an empty log render the did-NOT-land
  // wording — a failed read is NOT an empty log); logUnreadable means the
  // LAST read FAILED. reconcileFailed names which read(s) a reconcile lost
  // ("status" | "log" | "status + log"); null = no failed reconcile.
  const [logEntries, setLogEntries] = createSignal<GitLogEntry[]>([]);
  const [logLoaded, setLogLoaded] = createSignal(false);
  const [logUnreadable, setLogUnreadable] = createSignal(false);
  const [reconcileFailed, setReconcileFailed] = createSignal<string | null>(null);
  // Pending discard target for the in-app confirm (replaces window.confirm).
  // Holds the file path; null → dialog closed. Mirrors the archive-confirm
  // pattern in SessionContextMenu (signal + .dialog.confirm overlay).
  const [discardFile, setDiscardFile] = createSignal<string | null>(null);
  // Browser back dismisses the discard confirm (and consumes its entry).
  bindBackDismiss(() => discardFile() !== null, () => setDiscardFile(null), "discardconfirm");
  const files = () => status()?.files ?? [];
  const staged = () => files().filter(isStaged);
  const reload = () => { void refetch(); props.onChanged(); };
  // The uncertain banner only for the ACTIVE project dir — each repo's ward
  // is independent (a repo with no uncertain entry shows nothing, so a
  // ward from another repo never leaks onto this one).
  const uncertain = () => gitUncertainByDir()[projectDir()] ?? null;
  const commitWarded = () => uncertain()?.op === "commit";

  // Returns whether the read SUCCEEDED. On failure keep any previously
  // rendered rows (stale-but-real evidence beats fabricated emptiness) and
  // mark the log unreadable — the did-NOT-land wording must never appear
  // off a failed read.
  async function refreshLog(): Promise<boolean> {
    const xs = await gitLog(5);
    if (xs === null) {
      setLogUnreadable(true);
      setLogLoaded(false);
      return false;
    }
    setLogEntries(xs);
    setLogLoaded(true);
    setLogUnreadable(false);
    return true;
  }

  // Reconciliation (slice 6): one explicit gesture that refreshes BOTH the
  // status surface and the recent-commits log, then lifts the ward. The ward
  // lifts ONLY when BOTH reads SUCCEEDED (debate-2 Q3 — failed reads must
  // not count): gitStatus/gitLog resolve null on a failed read, and if the
  // ward lifted anyway, a still-broken link would "reconcile" with zero
  // successful reads, the operator could restage and re-commit the retained
  // message, and the original commit later landing would mint a duplicate.
  // On any failed read the banner + ward STAY and the banner surfaces an
  // honest could-not-refresh state; the exit stays a successful reconcile.
  // (The direct gitStatus() read is the verification signal — refetch
  // refreshes the staging resource exactly as before but is not a reliable
  // success oracle; both are idempotent GETs.)
  async function reconcile() {
    // Bind the reconcile to the repo it READS: the status/log queries carry
    // this dir, so a project switch mid-reconcile must not lift another
    // repo's ward off these reads' success.
    const dir = projectDir();
    const [st, logOk] = await Promise.all([gitStatus(), refreshLog(), refetch()]);
    props.onChanged();
    if (st !== null && logOk) {
      setReconcileFailed(null);
      clearGitUncertainDir(dir);
    } else {
      const failed = [st === null ? "status" : null, logOk ? null : "log"].filter(Boolean).join(" + ");
      setReconcileFailed(failed);
    }
  }

  async function act(fn: () => Promise<{ ok: boolean; error?: string; output?: string }>, okMsg?: string) {
    setBusy(true);
    try {
      const r = await fn();
      if (!r.ok) pushNotification({ kind: "error", title: "Git", detail: r.error || "failed" });
      else if (okMsg) pushNotification({ kind: "done", title: "Git", detail: r.output ? `${okMsg}: ${r.output.split("\n")[0]}` : okMsg });
      reload();
    } finally {
      setBusy(false);
    }
  }

  // Guarded commit/push (slice 6): GitView's busy flag serializes per-surface,
  // git-actions' per-repo latch covers remounts/second surfaces — "busy" here
  // is the belt-and-suspenders no-op. The message clears ONLY on a definitive
  // ok (the old code cleared it unconditionally, discarding the drafted text
  // for every failure AND every unknown).
  async function runMutation(op: "commit" | "push", fn: () => Promise<import("../git-actions").GitMutationResult>, okMsg: string) {
    if (busy()) return;
    setBusy(true);
    setRunningOp(op);
    // START-time dir: git-actions reads projectDir() in the same tick, so the
    // POST runs against THIS repo — the uncertain ward must bind to it even
    // if the operator switches projects before the outcome resolves
    // (B-F1/B-F2: reading projectDir() after the await tagged the wrong repo).
    const dir = projectDir();
    try {
      const r = await fn();
      if (r.outcome === "busy") return;
      if (r.outcome === "ok") {
        pushNotification({ kind: "done", title: "Git", detail: r.output ? `${okMsg}: ${r.output.split("\n")[0]}` : okMsg });
        if (op === "commit") setMessage("");
      } else if (r.outcome === "error") {
        pushNotification({ kind: "error", title: "Git", detail: r.error || "failed" });
      } else {
        // UNCERTAIN — the honesty path (fork-guard / reply-card discipline):
        // the POST may have been applied. Never "failed", never auto-retried.
        // The ward lands on the START-time repo; a push-uncertain never
        // weakens an active commit ward on the same repo (A-F1/A-F2).
        const changed = setGitUncertain({ dir, op, detail: r.detail });
        // A FRESH banner must not inherit the previous banner's failed-
        // reconcile line (A-F4) — but a retained commit ward keeps its own.
        if (changed) setReconcileFailed(null);
        // The reconciliation log is evidence for THIS banner: skip it when
        // the operator has moved on, rather than fetching the other repo's
        // log into this banner's rows.
        if (projectDir() === dir) void refreshLog();
        pushNotification({
          kind: "error",
          title: op === "commit" ? "Commit outcome unknown" : "Push outcome unknown",
          detail:
            op === "commit"
              ? "The commit was sent but no confirmation arrived — it may have landed. A blind retry can create a duplicate commit. " +
                "Open the Changes view and refresh the status and recent commits to see whether it landed before composing a new commit."
              : "The push was sent but no confirmation arrived — it may have reached the remote. " +
                "Retrying a push is safe (git re-pushes or reports 'up-to-date'). Open the Changes view to check the status first.",
        });
      }
      reload();
    } finally {
      setRunningOp(null);
      setBusy(false);
    }
  }

  return (
    <Show when={projectDir()} fallback={<p class="setting-hint git-hint">Open a project (not the default) to stage &amp; commit from here.</p>}>
      {/* Uncertain-outcome banner (slice 6). Rendered OUTSIDE the files gate
          on purpose: a landed-but-unconfirmed commit empties the staging
          list, and that is exactly when reconciliation matters most. */}
      <Show when={uncertain()}>
        {(u) => (
          <div class="git-uncertain" role="alert">
            <div class="git-uncertain-title">
              {u().op === "commit" ? "Commit outcome unknown" : "Push outcome unknown"}
            </div>
            <div class="git-uncertain-detail">
              {u().op === "commit"
                ? `No confirmation arrived (${u().detail}) — the commit may have landed. A blind retry can create a duplicate commit: refresh and check whether the staged files cleared and the message appears below before composing a new one.`
                : `No confirmation arrived (${u().detail}) — the push may have reached the remote. Retrying a push is safe (git re-pushes or reports "up-to-date").`}
            </div>
            <div class="git-uncertain-log">
              <div class="git-uncertain-log-head">Recent commits</div>
              <For each={logEntries()}>
                {(c) => (
                  <div class="git-uncertain-log-row">
                    <span class="git-uncertain-hash">{c.hash.slice(0, 7)}</span>
                    <span class="git-uncertain-subject">{c.subject}</span>
                    <span class="git-uncertain-date">{c.date}</span>
                  </div>
                )}
              </For>
              {/* Unreadable log: a FAILED read must never render the
                  did-NOT-land wording — that claim is only honest for a
                  SUCCESSFUL read that returned an empty log. */}
              <Show when={logUnreadable()}>
                <div class="git-uncertain-log-row git-uncertain-empty">
                  Could not read the recent commits (log unreadable) — this says nothing about whether the commit landed.
                </div>
              </Show>
              <Show when={logLoaded() && logEntries().length === 0}>
                <div class="git-uncertain-log-row git-uncertain-empty">
                  {u().op === "commit"
                    ? "No commits found — for a fresh repository this means the commit did NOT land."
                    : "No commits found."}
                </div>
              </Show>
            </div>
            {/* Failed reconcile: reads failed → banner + ward RETAINED with an
                honest could-not-refresh state. The retry affordance is the same
                Refresh button; the exit from uncertainty stays a SUCCESSFUL
                status+log reconcile. */}
            <Show when={reconcileFailed()}>
              <div class="git-uncertain-refresh-failed">
                {`Could not refresh — ${reconcileFailed() ?? "status/log"} unreadable (the read failed). Nothing was reconciled and the outcome is still unknown; try again.`}
              </div>
            </Show>
            <button type="button" class="git-mini" onClick={() => void reconcile()}>Refresh status &amp; log</button>
          </div>
        )}
      </Show>
      <Show when={files().length > 0} fallback={
        status.loading
          ? <div class="placeholder">Loading…</div>
          : <p class="setting-hint git-hint">Working tree clean.</p>
      }>
        <div class="git-stage">
          <div class="git-stage-head">
            <span>{files().length} changed</span>
            <span class="bar-spacer" />
            <button type="button" class="git-mini" disabled={busy()} onClick={() => void act(() => gitStage())}>Stage all</button>
            <button type="button" class="git-mini" disabled={busy()} onClick={() => void act(() => gitUnstage())}>Unstage all</button>
          </div>
          <For each={files()}>
            {(f: GitFile) => (
              <div class="git-stage-row" classList={{ staged: isStaged(f) }}>
                <span class="git-stage-x" data-tip={isStaged(f) ? "staged" : isUntracked(f) ? "untracked" : "modified"}>
                  {isStaged(f) ? "●" : isUntracked(f) ? "?" : "○"}
                </span>
                <span class="git-stage-name"><FileBadge path={f.file} /> {f.file}</span>
                <Show when={isStaged(f)} fallback={
                  <button type="button" class="git-mini" disabled={busy()} data-tip="Stage" aria-label="Stage" onClick={() => void act(() => gitStage([f.file]))}>+</button>
                }>
                  <button type="button" class="git-mini" disabled={busy()} data-tip="Unstage" aria-label="Unstage" onClick={() => void act(() => gitUnstage([f.file]))}>−</button>
                </Show>
                <button type="button" class="git-mini danger" disabled={busy()} data-tip="Discard changes" aria-label="Discard changes"
                  onClick={() => setDiscardFile(f.file)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}
          </For>
          <div class="git-commit">
            <textarea
              class="git-commit-msg"
              placeholder="Commit message…"
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              rows={2}
            />
            <div class="git-commit-actions">
              <button
                type="button"
                class="git-commit-btn"
                disabled={busy() || commitWarded() || !staged().length || !message().trim()}
                onClick={() => void runMutation("commit", () => gitCommit(message().trim()), "committed")}
              >
                {runningOp() === "commit" ? "Committing…" : `Commit (${staged().length})`}
              </button>
              <button
                type="button"
                class="git-mini"
                disabled={busy()}
                onClick={() => void runMutation("push", () => gitPush(), "pushed")}
              >
                {runningOp() === "push" ? "Pushing…" : "Push"}
              </button>
            </div>
          </div>
        </div>
      </Show>
      {/* Discard confirmation (replaces window.confirm). Same overlay/classes
          as the archive confirm in SessionContextMenu: signal-driven .dialog
          .confirm with the shared global confirm CSS. Confirm fires the same
          gitDiscard([file]) the old confirm(...) guard gated; Cancel clears. */}
      <Show when={discardFile()}>
        {(file) => (
          <div class="dialog-overlay" onClick={() => setDiscardFile(null)}>
            <div class="dialog confirm" role="dialog" aria-label="Confirm discard" onClick={(e) => e.stopPropagation()}>
              <div class="dialog-head">
                <span class="dialog-title">Discard changes</span>
                <button type="button" class="icon-btn" aria-label="Close" onClick={() => setDiscardFile(null)}>
                  <Icon name="x" />
                </button>
              </div>
              <div class="dialog-body">
                <p class="confirm-lead">
                  Discard changes to <strong>{file()}</strong>? This cannot be undone.
                </p>
              </div>
              <div class="confirm-actions">
                <button type="button" class="confirm-cancel" onClick={() => setDiscardFile(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="confirm-go"
                  disabled={busy()}
                  onClick={() => {
                    void act(() => gitDiscard([file()]));
                    setDiscardFile(null);
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}

export default function GitView() {
  const [mode, setMode] = createSignal<DiffMode>("git");
  const [info] = createResource(fetchVcsInfo);
  const [files, { refetch }] = createResource(mode, fetchVcsDiff);

  return (
    <div class="git">
      <div class="git-head">
        <span class="git-branch">
          <Show when={info()?.branch} fallback="—">
            ⎇ {info()!.branch}
          </Show>
        </span>
        <div class="seg">
          <button type="button" classList={{ on: mode() === "git" }} onClick={() => setMode("git")}>
            Working tree
          </button>
          <button
            type="button"
            classList={{ on: mode() === "branch" }}
            onClick={() => setMode("branch")}
            data-tip={info()?.default_branch ? `vs ${info()!.default_branch}` : "vs default branch"}
          >
            vs branch
          </button>
        </div>
        <div class="seg diff-layout" data-tip="Diff layout">
          <button type="button" classList={{ on: layout() === "unified" }} onClick={() => setLayout("unified")}>
            Inline
          </button>
          <button type="button" classList={{ on: layout() === "split" }} onClick={() => setLayout("split")}>
            Split
          </button>
        </div>
        <button type="button" class="git-refresh" data-tip="Refresh" aria-label="Refresh" onClick={() => refetch()}>
          ↻
        </button>
      </div>
      <div class="git-body">
        <Show when={mode() === "git"}>
          <StagingPanel onChanged={() => refetch()} />
        </Show>
        <Show
          when={(files() || []).length > 0}
          fallback={<div class="placeholder">{files.loading ? "Loading…" : "No changes"}</div>}
        >
          <For each={files()}>{(f) => <FilePatch file={f} />}</For>
        </Show>
      </div>
    </div>
  );
}
