import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { renderMarkdown } from "../render";
import { renderStreamMd } from "../lib/md";
import { renderMermaid } from "../lib/mermaid";
import { renderMathIn } from "../lib/math";
import { streamLive } from "../prefs";
import { openSession, setSelectedId } from "../sync";
import { openFile } from "../files";
import type { Part } from "../types";

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

// Inject a copy button into each server-rendered code block (innerHTML, so we
// enhance the DOM rather than the markup).
function addCodeCopyButtons(root: HTMLElement | undefined) {
  if (!root) return;
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = "copy";
    const code = pre.querySelector("code") as HTMLElement | null;
    btn.addEventListener("click", () => {
      void navigator.clipboard?.writeText((code ?? pre).innerText);
      btn.textContent = "copied";
      setTimeout(() => (btn.textContent = "copy"), 1200);
    });
    pre.appendChild(btn);
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
  // Instant client-rendered fallback (same renderer as the live stream) so a
  // block that just finished streaming shows formatted prose immediately instead
  // of flashing raw during the /vh/render round-trip; the server HTML (chroma +
  // sanitization) silently upgrades it. ONLY for `live` blocks (the message that
  // streamed in front of the user) — bulk-loaded history keeps the zero-cost raw
  // fallback so opening a long transcript doesn't run a marked.parse per block.
  const liveFallback = createMemo(() => (props.live ? renderStreamMd(props.text) : ""));
  let ref: HTMLDivElement | undefined;
  createEffect(() => {
    if (html())
      queueMicrotask(() => {
        renderMathIn(ref); // LaTeX → MathML before linkifying (skips code/links)
        addCodeCopyButtons(ref);
        linkifyPaths(ref);
      });
  });
  const onClick = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest(".filepath") as HTMLElement | null;
    if (t?.dataset.path) openFile(t.dataset.path, t.dataset.line ? Number(t.dataset.line) : undefined);
  };
  return (
    <Show
      when={html()}
      fallback={props.live ? <div class="md" innerHTML={liveFallback()} /> : <div class="md-raw">{props.text}</div>}
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
function Markdown(props: { text: string; settled: boolean }) {
  // Captured at creation: true only for a block that started while streaming
  // (the message the user is watching). History blocks are created already
  // settled → false → cheap raw fallback (no per-block client parse on load).
  const live = !props.settled;
  const [streamHtml, setStreamHtml] = createSignal("");
  let timer: number | undefined;
  createEffect(() => {
    const text = props.text;
    if (props.settled || !streamLive()) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => setStreamHtml(renderStreamMd(text)), 70);
  });
  onCleanup(() => clearTimeout(timer));
  const streamingView = () =>
    streamLive() ? (
      <div class="md md-stream">
        <div innerHTML={streamHtml()} />
        <span class="stream-caret" aria-hidden="true" />
      </div>
    ) : (
      <></>
    );
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

function ToolPart(props: { part: Part }) {
  const state = () => props.part.state || {};
  const status = () => state().status as string;
  // Shell output (bash) shows inline by default; other tools start collapsed.
  const [open, setOpen] = createSignal(props.part.tool === "bash");
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
  const expr = (): string => {
    const input = (state().input || (props.part as any).input || {}) as Record<string, any>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof input[k] === "string" && input[k]) return input[k] as string;
      return "";
    };
    switch (props.part.tool) {
      case "bash":
        return pick("command");
      case "glob":
        return pick("pattern", "query");
      case "grep":
        return pick("pattern", "query", "regex");
      case "read":
      case "write":
      case "edit":
      case "multiedit":
        return pick("filePath", "file", "path");
      case "list":
      case "ls":
        return pick("path", "dir");
      case "webfetch":
      case "fetch":
        return pick("url");
      default:
        return "";
    }
  };
  // Prefix the expression with a sigil hinting the tool kind ($ for shell).
  const exprPrefix = () => (props.part.tool === "bash" ? "$ " : "");
  // A `task` tool spawns a subagent; its child session id lets us jump there.
  const subId = (): string | undefined =>
    props.part.tool === "task"
      ? state().metadata?.sessionId || props.part.metadata?.sessionId
      : undefined;
  const jump = () => {
    const id = subId();
    if (id) {
      setSelectedId(id);
      void openSession(id);
    }
  };
  return (
    <div class="tool" classList={{ [status()]: true }}>
      <button type="button" class="tool-head" onClick={() => setOpen((v) => !v)}>
        <span class="tool-status" />
        <span class="tool-name">{props.part.tool}</span>
        <span class="tool-state">{state().title || status()}</span>
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
      <Show when={open()}>
        <Show when={expr()}>
          <pre class="tool-cmd">{exprPrefix()}{expr()}</pre>
        </Show>
        <Show when={output()}>
          <ToolBody text={output()} />
        </Show>
      </Show>
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
function ReasoningPart(props: { part: Part; settled: boolean }) {
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
  return (
    <details class="reasoning">
      <summary>
        <span>thinking</span>
        <Show when={elapsed()}>
          <span class="reasoning-time" classList={{ live: live() }}>{elapsed()}</span>
        </Show>
      </summary>
      <Markdown text={props.part.text || ""} settled={props.settled} />
    </details>
  );
}

export default function PartView(props: { part: Part; settled?: boolean }) {
  const p = () => props.part;
  // A part is settled (worth the full markdown render) when the part itself has
  // ended, or when the owning message is settled — user messages never stream,
  // and a completed assistant turn settles all its parts at once.
  const settled = () => props.settled || !!p().time?.end;
  return (
    <Switch>
      <Match when={p().type === "text"}>
        <Markdown text={p().text || ""} settled={settled()} />
      </Match>
      <Match when={p().type === "reasoning"}>
        <ReasoningPart part={p()} settled={settled()} />
      </Match>
      <Match when={p().type === "tool"}>
        <ToolPart part={p()} />
      </Match>
      <Match when={p().type === "file"}>
        <div class="file-chip">📎 {p().filename || p().mime}</div>
      </Match>
      {/* step-start/finish, snapshot, patch, agent, retry, compaction: omitted in v1 */}
    </Switch>
  );
}
