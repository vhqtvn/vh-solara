import { createResource, createSignal, For, Show } from "solid-js";
import { type DiffMode, type FileDiff, fetchVcsDiff, fetchVcsInfo } from "../git";
import { renderPatch } from "../render";
import { loadVersioned, saveVersioned } from "../lib/store";
import { projectDir } from "../sync";
import { type GitFile, gitCommit, gitDiscard, gitPush, gitStage, gitStatus, gitUnstage, isStaged, isUntracked } from "../git-actions";
import { pushNotification } from "../notify";
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
  const files = () => status()?.files ?? [];
  const staged = () => files().filter(isStaged);
  const reload = () => { void refetch(); props.onChanged(); };

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

  return (
    <Show when={projectDir()} fallback={<p class="setting-hint git-hint">Open a project (not the default) to stage &amp; commit from here.</p>}>
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
                  <button type="button" class="git-mini" disabled={busy()} data-tip="Stage" onClick={() => void act(() => gitStage([f.file]))}>+</button>
                }>
                  <button type="button" class="git-mini" disabled={busy()} data-tip="Unstage" onClick={() => void act(() => gitUnstage([f.file]))}>−</button>
                </Show>
                <button type="button" class="git-mini danger" disabled={busy()} data-tip="Discard changes"
                  onClick={() => { if (confirm(`Discard changes to ${f.file}? This cannot be undone.`)) void act(() => gitDiscard([f.file])); }}>
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
              <button type="button" class="git-commit-btn" disabled={busy() || !staged().length || !message().trim()}
                onClick={() => void act(() => gitCommit(message().trim()), "committed").then(() => setMessage(""))}>
                Commit ({staged().length})
              </button>
              <button type="button" class="git-mini" disabled={busy()} onClick={() => void act(() => gitPush(), "pushed")}>Push</button>
            </div>
          </div>
        </div>
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
        <button type="button" class="git-refresh" onClick={() => refetch()}>
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
