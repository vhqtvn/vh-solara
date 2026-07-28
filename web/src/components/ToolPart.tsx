// Tool-rendering concern extracted from components/Part.tsx (TS refactor slice 2).
// Houses the tool-row component (ToolPart), its output renderer (ToolBody), the
// tool-output → markdown-fence classifiers (jsonPretty / looksXML), and the
// tool-icon / duration helpers ToolPart consumes. Behavior-preserving move from
// Part.tsx — bodies carried character-for-character; only `export` keywords
// added where the new Part.tsx ↔ ToolPart.tsx seam or the characterization test
// requires it.
//
// GPU-heat invariants (see AGENTS.md → "Web frontend performance"): this module
// holds NONE of the streaming-render loop (FRAME_MS=200 coalesce / StreamMd.push
// live in Part.tsx's <Markdown>). ToolBody renders output through <MarkdownHtml>
// (the settled server-rendered path), never inside the per-frame streaming path.
// No mask-image / backdrop-filter:blur / per-element contain:paint here.
//
// Cross-module seam: ToolPart needs the id-keyed expand store (partOpen /
// setPartOpen) and the <MarkdownHtml> primitive, both of which stay in Part.tsx
// (shared with <Markdown> / <ReasoningPart>). The resulting Part.tsx ↔
// ToolPart.tsx import cycle is runtime-safe — every cross-module reference is
// inside a component body (resolved lazily), never at module-evaluation time, so
// there is no TDZ hazard.

import { createEffect, createMemo, createSignal, For, Match, Show, Switch, onCleanup } from "solid-js";
import { openFileAt } from "../code/frame";
import { onActionKey } from "../lib/a11y";
import { toolLabel, toolSubject } from "../lib/toolLabel";
import { openSession, projectDir, sessionNeedsInput, sessionWorking, setSelectedId, state as syncState, currentVerb } from "../sync";
import type { CurrentVerb } from "../sync";
import type { Part } from "../types";
import Icon from "./Icon";
import Spinner from "./Spinner";
import { MarkdownHtml, partOpen, setPartOpen } from "./Part";
import styles from "./Part.module.css";

// Map a tool to one of our available Icon glyphs (see Icon.tsx).
// Exported so the characterization test (tests/unit/toolRender.test.ts) can pin
// the tool-name → glyph mapping without mounting the component.
export function toolIconName(tool: string): string {
  const t = (tool || "").toLowerCase();
  if (/(edit|write|patch|create|str_replace)/.test(t)) return "edit";
  if (/(bash|shell|cmd|terminal)/.test(t)) return "terminal";
  if (/(read|view|cat)/.test(t)) return "eye";
  if (/(grep|search|find|glob|ripgrep)/.test(t)) return "filter";
  if (/(list|ls|dir)/.test(t)) return "menu";
  if (/(fetch|curl|wget|web|google|bing)/.test(t)) return "send";
  if (/(task|agent)/.test(t)) return "fork";
  if (/todo/.test(t)) return "check";
  if (/question/.test(t)) return "help";
  if (/(lsp|skill)/.test(t)) return "info";
  return "layers";
}

// The dynamic fields Part.tsx reads off a tool part's `state` (OpenCode's
// payload). Typed once here so the part's `[k: string]: unknown` index signature
// is narrowed in one place rather than cast at every access.
interface ToolState {
  status?: string;
  output?: string;
  error?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, any>;
  time?: { start?: number; end?: number };
  title?: string;
}

// Tool duration from its state.time (start→end), formatted like the reasoning
// timer. Empty until the tool finishes.
function durationText(part: Part): string {
  const time = ((part.state as ToolState | undefined)?.time || part.time || {}) as { start?: number; end?: number };
  const s = time.start;
  const e = time.end;
  if (!s || !e) return "";
  const secs = Math.max(0, (e - s) / 1000);
  const d = secs < 0.05 ? 0.1 : secs;
  return d < 60 ? `${d.toFixed(1)}s` : `${Math.floor(d / 60)}m ${Math.round(d % 60)}s`;
}

// Detect JSON / XML so tool output can be syntax-highlighted (server render via
// a fenced code block) instead of shown as flat text.
// Exported so the characterization test (tests/unit/toolRender.test.ts) can pin
// the classifier behavior directly (these drive ToolBody's fence decision).
export function jsonPretty(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
export function looksXML(s: string): boolean {
  const t = s.trim();
  return /^<[a-zA-Z?!]/.test(t) && /<\/[a-zA-Z][\w:-]*>\s*$/.test(t);
}

// Tool output body: highlight valid JSON / XML through the markdown code path,
// otherwise show it as plain preformatted text.
function ToolBody(props: { text: string }) {
  const fenced = (): string | null => {
    const j = jsonPretty(props.text);
    if (j) return "```json\n" + j + "\n```";
    if (looksXML(props.text)) return "```xml\n" + props.text.trim() + "\n```";
    return null;
  };
  return (
    <Show when={fenced()} fallback={<pre class={styles["tool-output"]}>{props.text}</pre>}>
      <div class={`${styles["tool-output"]} ${styles["tool-output-code"]}`}>
        <MarkdownHtml text={fenced()!} />
      </div>
    </Show>
  );
}

export function ToolPart(props: { part: Part; tail?: boolean }) {
  const state = () => (props.part.state || {}) as ToolState;
  const tool = () => (props.part.tool as string | undefined) ?? "";
  const status = () => state().status ?? "";
  // Live duration timer — mirrors ReasoningPart's elapsed() (see ~line 590):
  // while the tool is running (status "running", a real start, no end yet) the
  // slot ticks once a second; once `end` lands it falls back to durationText()'s
  // sub-second-precise final value. The interval is per-row (cheap at 1fps — the
  // same convention the reasoning timer uses) and torn down via onCleanup so a
  // scrolled-off / collapsed row never leaks a ticking timer.
  const time = () => state().time || props.part.time || {};
  const start = () => time().start;
  const end = () => time().end;
  const running = () => status() === "running" && !!start() && !end();
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!running() || !start()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const liveDuration = () => {
    if (running()) {
      const s = start();
      if (!s) return "";
      const secs = Math.max(0, Math.round((now() - s) / 1000));
      return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    }
    return durationText(props.part);
  };
  const output = () => state().output || state().error || "";
  // LSP diagnostics OpenCode attaches to edit/write/patch results, keyed by file.
  // Surface the errors (severity 1) so a broken edit is visible without digging.
  const diagnostics = (): { line: number; col: number; message: string }[] => {
    const meta = state().metadata as any;
    const byFile = meta?.diagnostics;
    if (!byFile) return [];
    const input = (state().input || (props.part as any).input || {}) as Record<string, any>;
    const fp = input.filePath || input.path;
    const list = (fp && byFile[fp]) || (Object.keys(byFile).length === 1 ? Object.values(byFile)[0] : null);
    if (!Array.isArray(list)) return [];
    return list
      .filter((d: any) => d?.severity === 1)
      .map((d: any) => ({
        line: (d.range?.start?.line ?? 0) + 1,
        col: (d.range?.start?.character ?? 0) + 1,
        message: String(d.message || ""),
      }));
  };
  // The salient input "expression" for a tool — the command for bash, the
  // pattern for glob/grep, the path for read/write, the url for webfetch, etc.
  // The title is only a short description, so show the real argument that ran.
  // Logic lives in the shared toolSubject() helper (also used by the Working
  // pill) so the per-tool argument mapping has one home.
  const expr = (): string => toolSubject(props.part);
  // Prefix the expression with a sigil hinting the tool kind ($ for shell).
  const exprPrefix = () => (tool() === "bash" ? "$ " : "");
  // The file a read/edit/write-style tool touched → openable in the code view.
  // Make a project-absolute path relative; ignore non-file tools (bash/grep/etc.).
  const openableFile = (): string => {
    const input = (state().input || (props.part as any).input || {}) as Record<string, any>;
    const fp = input.filePath || input.path;
    if (typeof fp !== "string" || !fp) return "";
    const root = projectDir();
    if (root && (fp === root || fp.startsWith(root + "/"))) return fp.slice(root.length + 1);
    if (fp.startsWith("/")) return ""; // absolute, outside the project — can't open
    return fp;
  };
  // A `task` tool spawns a subagent; its child session id lets us jump there.
  const subId = (): string | undefined =>
    tool() === "task"
      ? state().metadata?.sessionId || (props.part.metadata as { sessionId?: string } | undefined)?.sessionId
      : undefined;
  const jump = () => {
    const id = subId();
    if (id) {
      setSelectedId(id);
      void openSession(id);
    }
  };
  // Depth-1 live status of the spawned subagent. For a RESIDENT tree node the
  // reads trust the server-computed facets (flags.subtreeBusy /
  // subtreeNeedsInput — the same source the tree row uses); for a non-resident
  // child the self-only fallback reads syncState.activity[id] and the
  // permissions/questions maps directly. Either way Solid tracks the specific
  // signals read, so this memo only re-runs when the child's status TRANSITIONS.
  // Token streaming mutates state.messages, never these maps, so the indicator
  // stays stable across tokens (the row itself already persists in place via
  // upsertPart). Hidden when idle — nothing to flag — mirroring the session
  // tree. (Aliased `state as syncState` because this module's local `state` is
  // the tool part's own state accessor at line 369.)
  const childStatus = createMemo<"none" | "error" | "needs-input" | "working" | "idle">(() => {
    const id = subId();
    if (!id) return "none";
    if (syncState.activity[id] === "error") return "error";
    if (sessionNeedsInput(id)) return "needs-input";
    if (sessionWorking(id)) return "working";
    return "idle";
  });
  // Rich activity verb for the spawned subagent ("Reading parser.go"), surfaced
  // WITHOUT opening the child: currentVerb(id) reads the Tier-A facet
  // (syncState.currentVerbs) for an unopened child and formats it via the same
  // toolVerb/toolSubject as the opened path; an opened child uses its loaded
  // messages. Direct proxy reads only — transition-bounded (the memo only
  // re-runs when the child's verb slice changes), no ticking clock here so the
  // selector stays clock-free. "" for the generic "Working" fallback keeps the
  // bare spinner there (matches today's behavior; "Working" text everywhere
  // would be noisy and defeat the rich-verb goal).
  const childVerb = createMemo<CurrentVerb | null>(() => {
    const id = subId();
    return id ? currentVerb(id) : null;
  });
  const verbLabel = createMemo(() => {
    const v = childVerb();
    if (!v || v.verb === "Working") return "";
    return v.subject ? `${v.verb} ${v.subject}` : v.verb;
  });
  // Only the command/expression + output are behind the toggle (diagnostics show
  // regardless). A row with neither has nothing to expand → no chevron, no toggle.
  const hasDetail = () => !!(expr() || output());
  // Default open only for the streaming tail (the session's last item); persisted
  // per id so a manual toggle survives streaming re-renders.
  const expanded = () => partOpen[props.part.id] ?? (!!props.tail && hasDetail());
  const toggle = () => hasDetail() && setPartOpen(props.part.id, !expanded());
  // Keep the detail mounted once opened so the close animation has content.
  const [revealed, setRevealed] = createSignal(expanded());
  createEffect(() => {
    if (expanded()) setRevealed(true);
  });
  return (
    <div class="tool" classList={{ [status()]: true }}>
      <div
        role="button"
        tabindex="0"
        class="tool-head"
        classList={{ "no-toggle": !hasDetail() }}
        onClick={toggle}
        onKeyDown={onActionKey(toggle)}
      >
        {/* Running tools show the session-list shimmer (smaller); finished/failed
            show a static status dot. */}
        <Show when={status() === "running"} fallback={<span class={styles["tool-status"]} />}>
          <Spinner class={styles["tool-spin"]} size={10} />
        </Show>
        <span class={styles["tool-ico"]}><Icon name={toolIconName(tool())} size={13} /></span>
        <span class="tool-name">{toolLabel(tool())}</span>
        <span class={styles["tool-subject"]}>{expr() || state().title || status()}</span>
        <Show when={liveDuration()}>
          <span class="tool-dur" classList={{ live: running() }}>{liveDuration()}</span>
        </Show>
        <Show when={hasDetail()}>
          <span class={styles["tool-chev"]} classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
        </Show>
        <Show when={openableFile()}>
          <span
            role="button"
            tabindex="0"
            class={styles["tool-open"]}
            data-tip="Open in code view"
            aria-label="Open in code view"
            onClick={(e) => { e.stopPropagation(); openFileAt(openableFile()); }}
            onKeyDown={onActionKey(() => openFileAt(openableFile()))}
          >
            <Icon name="layers" size={13} />
          </span>
        </Show>
        <Show when={subId()}>
          {/* Depth-1 live status of the spawned subagent (Tier-A store data
              only). Mirrors the session-tree dot affordance: error → red dot,
              needs-input → amber pulse, working → accent spinner. Idle renders
              nothing (no Match hits) — nothing to flag. Sits left of the fork. */}
          <Switch>
            <Match when={childStatus() === "error"}>
              <span class={`${styles["tool-sub-status"]} error`} data-tip="error" aria-label="error" />
            </Match>
            <Match when={childStatus() === "needs-input"}>
              <span class={`${styles["tool-sub-status"]} needs-input`} data-tip="needs your input — reply to continue" aria-label="needs your input" />
            </Match>
            <Match when={childStatus() === "working"}>
              <span
                class={styles["tool-sub-spin"]}
                data-tip={verbLabel() || "working"}
                aria-label={verbLabel() || "working"}
              >
                <Spinner size={11} />
                <Show when={verbLabel()}>
                  <span class={styles["tool-sub-verb"]}>{verbLabel()}</span>
                </Show>
              </span>
            </Match>
          </Switch>
          <span
            role="button"
            tabindex="0"
            class="tool-jump"
            data-tip="Open subsession"
            aria-label="Open subsession"
            onClick={(e) => {
              e.stopPropagation();
              jump();
            }}
            onKeyDown={onActionKey(jump)}
          >
            <Icon name="fork" size={13} />
          </span>
        </Show>
      </div>
      <div class={styles.disclosure} classList={{ open: expanded() }}>
        <div class={styles["disclosure-clip"]}>
          <Show when={revealed()}>
            <Show when={expr()}>
              <pre class={styles["tool-cmd"]}>{exprPrefix()}{expr()}</pre>
            </Show>
            <Show when={output()}>
              <ToolBody text={output()} />
            </Show>
          </Show>
        </div>
      </div>
      {/* Diagnostics show even when collapsed — an edit that broke the file
          shouldn't require expanding to notice. */}
      <Show when={diagnostics().length > 0}>
        <div class={styles["tool-diags"]}>
          <For each={diagnostics()}>
            {(d) => (
              <div class="tool-diag">
                <span class="tool-diag-loc">[{d.line}:{d.col}]</span> {d.message}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
