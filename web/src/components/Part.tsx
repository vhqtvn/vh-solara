import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { renderMarkdown } from "../render";
import { renderStreamMd } from "../lib/md";
import { StreamMd } from "../lib/streamMd";
import { placeStreamCaret } from "../lib/streamCaret";
import { renderMermaid } from "../lib/mermaid";
import { renderMathIn } from "../lib/math";
import { streamLive } from "../prefs";
import { openSession, projectDir, setSelectedId } from "../sync";
import { openFileAt } from "../code/frame";
import { looksLikePath } from "../lib/pathlike";
import { toolLabel, toolSubject } from "../lib/toolLabel";
import type { Part } from "../types";
import Icon from "./Icon";
import Spinner from "./Spinner";

// Map a tool to one of our available Icon glyphs (see Icon.tsx).
function toolIconName(tool: string): string {
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
// Per-part expand state, keyed by part id and held OUTSIDE the components.
// The chat re-groups parts into fresh arrays as a turn streams, which re-creates
// the row components — local open signals would reset on every new token (a
// manually-expanded Thinking/tool would snap shut). Keying by id here makes the
// toggle survive that churn.
const [partOpen, setPartOpenStore] = createStore<Record<string, boolean>>({});
const setPartOpen = (id: string, v: boolean) => setPartOpenStore(id, v);

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

// Linkify file paths (containing "/" + an extension, optional :line) in
// rendered prose so they jump to the file. Skips code/links.
function linkifyPaths(root: HTMLElement | undefined) {
  if (!root) return;
  const detect = /[\w.\-]+\/[\w.\-/]*\.[A-Za-z][\w]{0,7}/;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.closest("pre,code,a,.filepath")) return NodeFilter.FILTER_REJECT;
      return detect.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) nodes.push(cur as Text);
  const re = /([\w.\-]+\/[\w.\-/]*\.[A-Za-z][\w]{0,7})(?::(\d+))?/g;
  for (const node of nodes) {
    const text = node.nodeValue || "";
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement("span");
      span.className = "filepath";
      span.textContent = m[0];
      span.dataset.path = m[1];
      if (m[2]) span.dataset.line = m[2];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

// Tag path-like inline code (`src/foo.ts`) so it can show a go-to affordance
// while a modifier is held (see the .mod-down rule); ctrl/cmd-click opens it.
function tagInlineCodePaths(root: HTMLElement | undefined) {
  if (!root) return;
  root.querySelectorAll("code").forEach((c) => {
    if (c.closest("pre") || c.classList.contains("code-pathlike")) return;
    if (looksLikePath(c.textContent || "")) c.classList.add("code-pathlike");
  });
}

// Inject copy + word-wrap buttons into each server-rendered code block
// (innerHTML, so we enhance the DOM rather than the markup). Each pre is wrapped
// in a non-scrolling .code-block container: the pre itself is the horizontal
// scroll surface for long lines, so anchoring the action buttons to the wrapper
// (which does not scroll) keeps them pinned at the top-right instead of riding
// off-screen with the scrolled content.
function addCodeCopyButtons(root: HTMLElement | undefined) {
  if (!root) return;
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".code-block")) return; // already wrapped
    const parent = pre.parentElement;
    if (!parent) return;
    const block = document.createElement("div");
    block.className = "code-block";
    parent.replaceChild(block, pre);
    block.appendChild(pre);

    const actions = document.createElement("div");
    actions.className = "code-actions";

    // Word-wrap toggle (renders to the LEFT of copy via the flex container).
    const wrapBtn = document.createElement("button");
    wrapBtn.type = "button";
    wrapBtn.className = "code-wrap";
    wrapBtn.textContent = "wrap";
    wrapBtn.addEventListener("click", () => {
      const on = pre.classList.toggle("wrap");
      wrapBtn.textContent = on ? "unwrap" : "wrap";
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "code-copy";
    copyBtn.textContent = "copy";
    const code = pre.querySelector("code") as HTMLElement | null;
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard?.writeText((code ?? pre).innerText);
      copyBtn.textContent = "copied";
      setTimeout(() => (copyBtn.textContent = "copy"), 1200);
    });

    // DOM order in the flex container = visual order: wrap (left), copy (right).
    actions.appendChild(wrapBtn);
    actions.appendChild(copyBtn);
    block.appendChild(actions);
  });
}

// Split markdown into alternating prose / mermaid segments.
function splitMermaid(text: string): { type: "md" | "mermaid"; content: string }[] {
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  const out: { type: "md" | "mermaid"; content: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "md", content: text.slice(last, m.index) });
    out.push({ type: "mermaid", content: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "md", content: text.slice(last) });
  return out;
}

// One prose segment: daemon-rendered, syntax-highlighted HTML with copy buttons
// and clickable file paths.
function MarkdownHtml(props: { text: string; live?: boolean }) {
  const [html] = createResource(
    () => props.text,
    (t) => renderMarkdown(t),
  );
  // Instant client-rendered fallback (same renderer as the live stream) shown
  // until the server HTML (chroma highlighting + sanitization) arrives and
  // silently upgrades it. Used for history too — opening a session otherwise
  // flashed RAW text → rendered as each block's /vh/render round-trip resolved.
  // The cost is bounded: only on-screen parts mount (Deferred), so this is a
  // handful of parses, not the whole transcript.
  const clientMd = createMemo(() => renderStreamMd(props.text));
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    if (html())
      queueMicrotask(() => {
        renderMathIn(ref); // LaTeX → MathML before linkifying (skips code/links)
        addCodeCopyButtons(ref);
        linkifyPaths(ref);
        tagInlineCodePaths(ref);
      });
  });
  const onClick = (e: MouseEvent) => {
    const tgt = e.target as HTMLElement;
    // Ctrl/Cmd-click a path-like inline code span (`src/foo.ts`) opens it — like
    // an editor's go-to. (Linkified .filepath spans, below, open on a plain click.)
    if (e.metaKey || e.ctrlKey) {
      const codeEl = tgt.closest("code") as HTMLElement | null;
      if (codeEl && !codeEl.closest("pre")) {
        const txt = (codeEl.textContent || "").trim();
        if (looksLikePath(txt)) {
          e.preventDefault();
          openFileAt(txt);
          return;
        }
      }
    }
    const t = tgt.closest(".filepath") as HTMLElement | null;
    if (t?.dataset.path) openFileAt(t.dataset.path, t.dataset.line ? Number(t.dataset.line) : undefined);
  };
  return (
    <Show
      when={html()}
      fallback={<div class="md" innerHTML={clientMd()} />}
    >
      <div class="md" ref={ref} innerHTML={html()!} onClick={onClick} />
    </Show>
  );
}

function downloadSvg(svg: string, name: string) {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Inline mermaid diagram with copy/download actions.
function Mermaid(props: { src: string }) {
  const [svg] = createResource(() => props.src, renderMermaid);
  return (
    <div class="mermaid-block">
      <Show when={svg()} fallback={<pre class="md-raw">{props.src}</pre>}>
        <div class="mermaid-svg" innerHTML={svg()!} />
      </Show>
      <div class="mermaid-actions">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(props.src)}>
          copy
        </button>
        <Show when={svg()}>
          <button type="button" onClick={() => downloadSvg(svg()!, "diagram.svg")}>
            download
          </button>
        </Show>
      </div>
    </div>
  );
}

// Markdown block: while streaming, show raw growing text (live mode) or hold it
// back entirely (block-by-block mode — the Working… shimmer covers progress).
// Once settled, render prose server-side and any mermaid fences as diagrams.
// While streaming, render markdown live on the client (debounced — re-parsing
// the whole text per token is O(n²)) so the in-flight reply is formatted, not
// raw. The settled view re-renders it server-side (highlighting + mermaid).
function Markdown(props: { text: string; settled: boolean; caret?: boolean }) {
  // Captured at creation: true only for a block that started while streaming
  // (the message the user is watching). History blocks are created already
  // settled → false → cheap raw fallback (no per-block client parse on load).
  const live = !props.settled;
  const streamingView = () => {
    if (!streamLive()) return <></>;
    let host: HTMLDivElement | undefined;
    let engine: StreamMd | undefined;
    // A detached caret node re-attached after each render (the active block is
    // rebuilt each render, which removes it), placed at the end of the last line.
    const caretEl = document.createElement("span");
    caretEl.className = "stream-caret";
    caretEl.setAttribute("aria-hidden", "true");

    // Render via the incremental engine, coalesced to a fixed rate and only when
    // the text actually changes (idle between deltas). 5fps keeps the live
    // formatted reveal smooth while bounding paint work per second.
    const FRAME_MS = 200; // ~5fps
    let timer: number | undefined;
    let lastRender = 0;
    // `force` re-formats the trailing block on demand (used on tab-resume so
    // inline markdown snaps in with the raw text, not up to REPARSE_MS later).
    // Steady-state flushes pass false and stay throttled by the REPARSE_MS cap
    // (heat guardrail — forced reparse is once-per-resume, never per-frame).
    const flush = (force = false) => {
      timer = undefined;
      if (!host) return;
      lastRender = performance.now();
      (engine ||= new StreamMd(host)).push(props.text, lastRender, force);
      if (props.caret) placeStreamCaret(host, caretEl);
    };
    createEffect(() => {
      void props.text;  // re-run as deltas arrive
      void props.caret; // and when this stops/starts being the tail
      if (props.settled || timer !== undefined) return; // a render is already queued — coalesce
      timer = window.setTimeout(flush, Math.max(0, FRAME_MS - (performance.now() - lastRender)));
    });
    // Snap-on-resume: while the tab is hidden the browser throttles setTimeout
    // to ≥1s (intensive throttling → ~once/30s), so flush() rarely fires and the
    // rendered length falls behind the store's text. On return to visible, cancel
    // any queued (throttled) tick and flush now — StreamMd.push drains an
    // arbitrarily large delta in one call, so the part snaps to the latest text
    // in a single frame instead of slowly floating in.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (props.settled) return; // live engine is unmounted on settle — nothing to snap
      if (timer === undefined) return; // nothing queued → renderer is current, nothing to snap
      clearTimeout(timer);
      timer = undefined;
      flush(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) clearTimeout(timer);
    });
    return <div class="md md-stream" ref={host} />;
  };
  return (
    <Show when={props.settled} fallback={streamingView()}>
      <For each={splitMermaid(props.text)}>
        {(seg) => (seg.type === "mermaid" ? <Mermaid src={seg.content} /> : <MarkdownHtml text={seg.content} live={live} />)}
      </For>
    </Show>
  );
}

// Detect JSON / XML so tool output can be syntax-highlighted (server render via
// a fenced code block) instead of shown as flat text.
function jsonPretty(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
function looksXML(s: string): boolean {
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
    <Show when={fenced()} fallback={<pre class="tool-output">{props.text}</pre>}>
      <div class="tool-output tool-output-code">
        <MarkdownHtml text={fenced()!} />
      </div>
    </Show>
  );
}

function ToolPart(props: { part: Part; tail?: boolean }) {
  const state = () => (props.part.state || {}) as ToolState;
  const tool = () => (props.part.tool as string | undefined) ?? "";
  const status = () => state().status ?? "";
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
      <button type="button" class="tool-head" classList={{ "no-toggle": !hasDetail() }} onClick={toggle}>
        {/* Running tools show the session-list shimmer (smaller); finished/failed
            show a static status dot. */}
        <Show when={status() === "running"} fallback={<span class="tool-status" />}>
          <Spinner class="tool-spin" size={10} />
        </Show>
        <span class="tool-ico"><Icon name={toolIconName(tool())} size={13} /></span>
        <span class="tool-name">{toolLabel(tool())}</span>
        <span class="tool-subject">{expr() || state().title || status()}</span>
        <Show when={durationText(props.part)}>
          <span class="tool-dur">{durationText(props.part)}</span>
        </Show>
        <Show when={hasDetail()}>
          <span class="tool-chev" classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
        </Show>
        <Show when={openableFile()}>
          <span
            role="button"
            tabindex="0"
            class="tool-open"
            data-tip="Open in code view"
            aria-label="Open in code view"
            onClick={(e) => { e.stopPropagation(); openFileAt(openableFile()); }}
          >
            <Icon name="layers" size={13} />
          </span>
        </Show>
        <Show when={subId()}>
          <span
            role="button"
            tabindex="0"
            class="tool-jump"
            onClick={(e) => {
              e.stopPropagation();
              jump();
            }}
          >
            open subsession →
          </span>
        </Show>
      </button>
      <div class="disclosure" classList={{ open: expanded() }}>
        <div class="disclosure-clip">
          <Show when={revealed()}>
            <Show when={expr()}>
              <pre class="tool-cmd">{exprPrefix()}{expr()}</pre>
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
        <div class="tool-diags">
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

// Reasoning block with a live "thinking" duration. While the part is still
// streaming the timer ticks (created → now); once it ends it shows the total.
function ReasoningPart(props: { part: Part; settled: boolean; tail?: boolean }) {
  const start = () => props.part.time?.start;
  const end = () => props.part.time?.end;
  const live = () => !props.settled && !end();
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!live() || !start()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const elapsed = () => {
    const s = start();
    if (!s) return "";
    const secs = Math.max(0, Math.round(((end() ?? now()) - s) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  };
  // Controlled (not native <details>) so the open state lives in the id-keyed
  // store and survives streaming re-renders. Default open only for the tail (the
  // live thinking) — no truncated snippet in the header; the body is the content.
  const expanded = () => partOpen[props.part.id] ?? !!props.tail;
  const toggle = () => setPartOpen(props.part.id, !expanded());
  // Keep the body mounted once opened so the close animation has content.
  const [revealed, setRevealed] = createSignal(expanded());
  createEffect(() => {
    if (expanded()) setRevealed(true);
  });
  // Bounded, scrollable body that sticks to the bottom while streaming — unless
  // the user scrolled up (then it stays put). A ResizeObserver on the content
  // re-anchors when new tokens grow it; onScroll tracks whether we're stuck.
  let bodyEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  let stick = true;
  const onScroll = () => {
    const e = bodyEl;
    if (e) stick = e.scrollHeight - e.scrollTop - e.clientHeight < 24;
  };
  createEffect(() => {
    if (!expanded() || !bodyEl || !contentEl) return;
    stick = true; // (re)opening starts anchored at the bottom
    const ro = new ResizeObserver(() => {
      if (stick && bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
    });
    ro.observe(contentEl);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class="reasoning" classList={{ open: expanded() }}>
      <button type="button" class="tool-head reasoning-head" onClick={toggle}>
        <span class="tool-ico"><Icon name="help" size={13} /></span>
        <span class="tool-name">Thinking</span>
        <span class="tool-subject" />
        <Show when={elapsed()}>
          <span class="tool-dur reasoning-time" classList={{ live: live() }}>{elapsed()}</span>
        </Show>
        <span class="tool-chev" classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
      </button>
      <div class="disclosure" classList={{ open: expanded() }}>
        <div class="disclosure-clip">
          <Show when={revealed()}>
            <div class="reasoning-body" ref={bodyEl} onScroll={onScroll}>
              <div ref={contentEl}>
                <Markdown text={(props.part.text as string) || ""} settled={props.settled} caret={props.tail} />
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default function PartView(props: { part: Part; settled?: boolean; tail?: boolean }) {
  const p = () => props.part;
  // A part is settled (worth the full markdown render) when the part itself has
  // ended, or when the owning message is settled — user messages never stream,
  // and a completed assistant turn settles all its parts at once.
  const settled = () => props.settled || !!p().time?.end;
  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Markdown text={(p().text as string) || ""} settled={settled()} caret={props.tail} />
      </Match>
      <Match when={p().type === "reasoning"}>
        <ReasoningPart part={p()} settled={settled()} tail={props.tail} />
      </Match>
      <Match when={p().type === "tool"}>
        <ToolPart part={p()} tail={props.tail} />
      </Match>
      <Match when={p().type === "file"}>
        <div class="file-chip">📎 {(p().filename as string) || (p().mime as string)}</div>
      </Match>
      {/* step-start/finish, snapshot, patch, agent, retry, compaction: omitted in v1 */}
    </Switch>
  );
}

// ActivityGroup renders a run of consecutive tool/reasoning parts as one compact
// "Activity" timeline (OpenChamber-style): a header that discloses the full list
// with a smooth open/close animation, and per-row expand-to-full-detail (every
// tool, not just some — our deliberate divergence from OpenChamber). Collapsed
// shows only the header + count; the LAST group in the conversation auto-opens.
export function ActivityGroup(props: { parts: Part[]; settled: boolean; tailId?: string | null; isLast?: boolean }) {
  // Expanded by default (the activity timeline shouldn't hide itself); `override`
  // records a manual toggle and then wins, so a group you collapsed stays
  // collapsed as fresh activity streams in.
  const [override, setOverride] = createSignal<boolean | null>(null);
  const expanded = () => override() ?? true;
  const total = () => props.parts.length;
  // Keep the rows mounted once revealed so the collapse animation has content to
  // shrink; a never-opened old group renders no rows at all (cheap history).
  const [revealed, setRevealed] = createSignal(expanded());
  createEffect(() => {
    if (expanded()) setRevealed(true);
  });
  return (
    <div class="activity">
      <button
        type="button"
        class="activity-head"
        aria-expanded={expanded()}
        onClick={() => setOverride(!expanded())}
      >
        <Icon name="cpu" size={14} />
        <span class="activity-title">Activity</span>
        <span class="activity-count">{total()}</span>
        <span class="activity-chev" classList={{ rot: expanded() }}><Icon name="chevronDown" size={12} /></span>
      </button>
      <div class="activity-rows-wrap" classList={{ open: expanded() }}>
        <div class="activity-rows">
          <Show when={revealed()}>
            <For each={props.parts}>
              {(p) => (
                <Switch>
                  <Match when={p.type === "reasoning"}>
                    <ReasoningPart part={p} settled={props.settled} tail={p.id === props.tailId} />
                  </Match>
                  <Match when={p.type === "tool"}>
                    <ToolPart part={p} tail={p.id === props.tailId} />
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
