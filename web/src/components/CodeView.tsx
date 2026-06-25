import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { projectDir } from "../sync";
import { codeFile, codeLangs, codeRawUrl, codeSearch, codeStatus, codeStyles, codeTree, type CodeEntry, type CodeFile, type CodeHit } from "../codeApi";
import { codeOpenPath, setCodeOpenPath, codeOpenLine, setCodeOpenLine } from "../code";
import { codeStyle, setCodeStyle, codeWrap, setCodeWrap, codeShowIgnored, setCodeShowIgnored } from "../prefs";
import Icon from "./Icon";
import Select from "./Select";
import Spinner from "./Spinner";

// Read-only codebase view: lazy file tree + git-grep search on the left, a
// server-highlighted file on the right. Heavy work (tree, search, highlight) is
// all on the daemon; this component just renders results.

function fileIcon(name: string): string {
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(name)) return "eye";
  if (/\.(md|markdown)$/i.test(name)) return "info";
  return "paperclip";
}

// One tree node; children load lazily on first expand. Right-click / long-press
// a folder to focus it (re-root the tree) via onCtx.
function TreeNode(props: {
  entry: CodeEntry;
  depth: number;
  openPath: () => string;
  onOpen: (p: string) => void;
  onCtx: (x: number, y: number, path: string) => void;
  status: () => Record<string, string>;
  showIgnored: () => boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [kids] = createResource(open, (o) => (o ? codeTree(props.entry.path) : Promise.resolve<CodeEntry[] | null>(null)));
  const isDir = props.entry.type === "dir";
  const selected = () => props.openPath() === props.entry.path;
  let lpTimer: ReturnType<typeof setTimeout> | undefined;
  const ctx = (x: number, y: number) => isDir && props.onCtx(x, y, props.entry.path);
  const visibleKids = () => (props.showIgnored() ? kids() || [] : (kids() || []).filter((e) => !e.ignored));
  // Git status: a file's own code, or for a dir, "•" if any changed path is under it.
  const st = () => {
    if (!isDir) return props.status()[props.entry.path] || "";
    const p = props.entry.path + "/";
    for (const k in props.status()) if (k === props.entry.path || k.startsWith(p)) return "•";
    return "";
  };
  return (
    <div class="code-tree-node">
      <button
        type="button"
        class="code-tree-row"
        classList={{ dir: isDir, selected: selected(), ignored: !!props.entry.ignored }}
        style={{ "padding-left": `${4 + props.depth * 14}px` }}
        onClick={() => (isDir ? setOpen((v) => !v) : props.onOpen(props.entry.path))}
        onContextMenu={(e) => { if (isDir) { e.preventDefault(); ctx(e.clientX, e.clientY); } }}
        onPointerDown={(e) => { if (isDir && e.pointerType === "touch") lpTimer = setTimeout(() => ctx(e.clientX, e.clientY), 500); }}
        onPointerUp={() => clearTimeout(lpTimer)}
        onPointerLeave={() => clearTimeout(lpTimer)}
        title={props.entry.path}
      >
        <Show when={isDir} fallback={<span class="code-tree-ico file"><Icon name={fileIcon(props.entry.name)} size={13} /></span>}>
          <span class="code-tree-caret" classList={{ open: open() }}><Icon name="chevronDown" size={12} /></span>
        </Show>
        <span class="code-tree-name">{props.entry.name}</span>
        <Show when={st()}>
          <span class="code-st" classList={{ [`st-${st()}`]: true }}>{st()}</span>
        </Show>
      </button>
      <Show when={isDir && open()}>
        <Show when={!kids.loading} fallback={<div class="code-tree-loading" style={{ "padding-left": `${18 + props.depth * 14}px` }}>…</div>}>
          <For each={visibleKids()}>
            {(e) => <TreeNode entry={e} depth={props.depth + 1} openPath={props.openPath} onOpen={props.onOpen} onCtx={props.onCtx} status={props.status} showIgnored={props.showIgnored} />}
          </For>
        </Show>
      </Show>
    </div>
  );
}

export default function CodeView() {
  // Open path/line live in the module (../code) so they persist across tab
  // switches and can be driven by openFileAt() from the chat / search.
  const openPath = codeOpenPath;
  const setOpenPath = setCodeOpenPath;
  const targetLine = codeOpenLine;
  const setTargetLine = setCodeOpenLine;
  const [query, setQuery] = createSignal("");
  const [debounced, setDebounced] = createSignal("");
  const [mdRendered, setMdRendered] = createSignal(false);
  // Focus folder: re-root the tree + scope search to a subtree (monorepo digging).
  const [focusRoot, setFocusRoot] = createSignal("");
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number; path: string } | null>(null);
  let paneEl: HTMLDivElement | undefined;

  // Tree root reloads when the project or the focus folder changes.
  const [roots] = createResource(() => ({ dir: projectDir(), root: focusRoot() }), (k) => codeTree(k.root));
  // Git status decorations + language override.
  const [status] = createResource(() => projectDir(), () => codeStatus());
  const [langList] = createResource(codeLangs);
  const [langOverride, setLangOverride] = createSignal("");
  const visibleRoots = () => (codeShowIgnored() ? roots() || [] : (roots() || []).filter((e) => !e.ignored));
  // Crumb segments for the focus chip (‹ repo / a / b).
  const focusSegs = createMemo(() => {
    const f = focusRoot();
    if (!f) return [] as { name: string; path: string }[];
    let acc = "";
    return f.split("/").map((name) => ((acc = acc ? `${acc}/${name}` : name), { name, path: acc }));
  });

  // Debounced search.
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const q = query();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setDebounced(q), 220);
  });
  onCleanup(() => clearTimeout(searchTimer));
  const [results] = createResource(
    () => ({ q: debounced(), scope: focusRoot() }),
    (k) => (k.q.trim() ? codeSearch(k.q, k.scope) : Promise.resolve({ hits: [] as CodeHit[], capped: false })),
  );

  // Open file (resource keyed on path + markdown-render toggle + language override).
  const [file] = createResource(
    () => ({ path: openPath(), rendered: mdRendered(), lang: langOverride() }),
    (k) => (k.path ? codeFile(k.path, { view: k.rendered ? "rendered" : undefined, lang: k.lang || undefined }) : Promise.resolve<CodeFile | null>(null)),
  );

  const open = (path: string, line?: number) => {
    setMdRendered(false);
    setLangOverride(""); // a new file re-detects its language
    setTargetLine(line);
    setOpenPath(path);
  };

  // Scroll to + highlight the target line once the file's HTML is in the DOM.
  createEffect(() => {
    const f = file();
    const line = targetLine();
    if (!f || f.kind !== "text" || !line || !paneEl) return;
    queueMicrotask(() => {
      const anchor = paneEl!.querySelector(`#L${line}`);
      anchor?.scrollIntoView({ block: "center" });
      const lines = paneEl!.querySelectorAll(".lntable .lntd:last-child .line");
      const row = lines[line - 1] as HTMLElement | undefined;
      if (row) {
        row.classList.add("code-line-target");
        setTimeout(() => row.classList.remove("code-line-target"), 2400);
      }
    });
  });

  // Chroma style picker: when a non-default style is chosen, inject a scoped
  // sheet (re-themes only .code-hl). Default ("") follows the app theme.
  const [styleList] = createResource(codeStyles);
  createEffect(() => {
    const name = codeStyle();
    const id = "vh-code-hl";
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!name) {
      link?.remove();
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    link.href = `/vh/code/highlight.css?style=${encodeURIComponent(name)}`;
  });
  onCleanup(() => document.getElementById("vh-code-hl")?.remove());

  // Close the focus context menu on any outside click (armed next tick so the
  // opening contextmenu/long-press doesn't immediately dismiss it).
  createEffect(() => {
    if (!ctxMenu()) return;
    const close = () => setCtxMenu(null);
    const id = setTimeout(() => document.addEventListener("click", close), 0);
    onCleanup(() => { clearTimeout(id); document.removeEventListener("click", close); });
  });

  const segments = createMemo(() => {
    const p = openPath();
    if (!p) return [] as { name: string; path: string }[];
    const parts = p.split("/");
    let acc = "";
    return parts.map((name) => {
      acc = acc ? `${acc}/${name}` : name;
      return { name, path: acc };
    });
  });

  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const gotoLine = () => {
    const n = Number(prompt("Go to line"));
    if (n > 0) setTargetLine(undefined), setTargetLine(n);
  };

  return (
    <Show when={projectDir()} fallback={<div class="code-empty">Open a project (not the default) to browse its code.</div>}>
      <div class="code-view code-hl" classList={{ "has-file": !!openPath() }}>
        <aside class="code-sidebar">
          <div class="code-search">
            <Icon name="filter" size={13} />
            <input
              class="code-search-input"
              placeholder="Search code…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <Show when={query()}>
              <button type="button" class="code-search-clear" aria-label="Clear" onClick={() => setQuery("")}><Icon name="x" size={12} /></button>
            </Show>
          </div>
          <Show when={focusRoot()}>
            <div class="code-focus" title="Focused folder — tree & search are scoped here">
              <button type="button" class="code-focus-crumb" onClick={() => setFocusRoot("")}>‹ repo</button>
              <For each={focusSegs()}>
                {(seg, i) => (
                  <>
                    <span class="code-bc-sep">/</span>
                    <button type="button" class="code-focus-crumb" classList={{ last: i() === focusSegs().length - 1 }} onClick={() => setFocusRoot(seg.path)}>{seg.name}</button>
                  </>
                )}
              </For>
            </div>
          </Show>
          <div class="code-tree tree">
            <Show
              when={!debounced().trim()}
              fallback={
                <div class="code-results">
                  <Show when={!results.loading} fallback={<div class="code-tree-loading">Searching…</div>}>
                    <Show when={(results()?.hits.length ?? 0) > 0} fallback={<div class="code-tree-loading">No matches</div>}>
                      <For each={results()!.hits}>
                        {(h) => (
                          <button type="button" class="code-hit" onClick={() => open(h.path, h.line)} title={h.path}>
                            <span class="code-hit-loc">{h.path}:{h.line}</span>
                            <span class="code-hit-text">{h.text}</span>
                          </button>
                        )}
                      </For>
                      <Show when={results()!.capped}><div class="code-tree-loading">Showing first matches…</div></Show>
                    </Show>
                  </Show>
                </div>
              }
            >
              <Show when={!roots.loading} fallback={<div class="code-tree-loading">…</div>}>
                <For each={visibleRoots()}>
                  {(e) => (
                    <TreeNode
                      entry={e}
                      depth={0}
                      openPath={openPath}
                      onOpen={(p) => open(p)}
                      onCtx={(x, y, path) => setCtxMenu({ x, y, path })}
                      status={() => status() || {}}
                      showIgnored={codeShowIgnored}
                    />
                  )}
                </For>
                <button type="button" class="code-show-ignored" onClick={() => { setCodeShowIgnored(!codeShowIgnored()); }}>
                  {codeShowIgnored() ? "Hide ignored files" : "Show ignored files"}
                </button>
              </Show>
            </Show>
          </div>
        </aside>

        <main class="code-main">
          <Show when={openPath()} fallback={<div class="code-empty">Select a file to view.</div>}>
            <div class="code-bar">
              <button type="button" class="code-back" aria-label="Files" onClick={() => setOpenPath("")}><Icon name="menu" size={15} /></button>
              <div class="code-breadcrumb">
                <For each={segments()}>
                  {(seg, i) => (
                    <>
                      <Show when={i() > 0}><span class="code-bc-sep">/</span></Show>
                      <span class="code-bc-seg" classList={{ last: i() === segments().length - 1 }}>{seg.name}</span>
                    </>
                  )}
                </For>
              </div>
              <Show when={file()?.kind === "text"}>
                <Select
                  class="code-lang-select"
                  ariaLabel="Syntax language"
                  value={langOverride()}
                  options={[{ value: "", label: file()?.lang ? `Auto · ${file()!.lang}` : "Auto" }, ...((langList() ?? []).map((l) => ({ value: l, label: l })))]}
                  onChange={setLangOverride}
                />
              </Show>
              <div class="code-actions">
                <Show when={file()?.isMarkdown}>
                  <button type="button" class="btn code-btn" classList={{ on: mdRendered() }} onClick={() => setMdRendered((v) => !v)}>
                    {mdRendered() ? "Raw" : "Rendered"}
                  </button>
                </Show>
                <Show when={file()?.kind === "text"}>
                  <button type="button" class="icon-btn" data-tip="Go to line" aria-label="Go to line" onClick={gotoLine}><Icon name="arrowDown" size={14} /></button>
                  <button type="button" class="icon-btn" data-tip={codeWrap() ? "No wrap" : "Wrap"} aria-label="Wrap" classList={{ on: codeWrap() }} onClick={() => setCodeWrap(!codeWrap())}><Icon name="wrap" size={14} /></button>
                </Show>
                <button type="button" class="icon-btn" data-tip="Copy path" aria-label="Copy path" onClick={() => copy(openPath())}><Icon name="clipboard" size={14} /></button>
                <Select
                  class="code-style-select"
                  ariaLabel="Highlight style"
                  value={codeStyle()}
                  options={[{ value: "", label: "Theme default" }, ...((styleList()?.styles ?? []).map((s) => ({ value: s, label: s })))]}
                  onChange={setCodeStyle}
                />
              </div>
            </div>

            <div class="code-pane scroll-edges" classList={{ wrap: codeWrap() }} ref={paneEl}>
              <Show when={!file.loading} fallback={<div class="code-loading"><Spinner size={18} /></div>}>
                <Show when={file()} keyed>
                  {(f) => (
                    <Switch fallback={<div class="code-empty">{f.path}</div>}>
                      <Match when={f.kind === "image"}>
                        <div class="code-image"><img src={codeRawUrl(f.path)} alt={f.path} /></div>
                      </Match>
                      <Match when={f.kind === "binary"}>
                        <div class="code-empty">Binary file ({fmtSize(f.size)}) — <a href={codeRawUrl(f.path)} target="_blank" rel="noreferrer">download</a></div>
                      </Match>
                      <Match when={f.kind === "toolarge"}>
                        <div class="code-empty">File too large to preview ({fmtSize(f.size)}) — <a href={codeRawUrl(f.path)} target="_blank" rel="noreferrer">download</a></div>
                      </Match>
                      <Match when={f.kind === "markdown"}>
                        <div class="code-md md" innerHTML={f.html} />
                      </Match>
                      <Match when={f.kind === "text"}>
                        <div class="code-content" classList={{ raw: !f.highlighted }} innerHTML={f.html} />
                      </Match>
                    </Switch>
                  )}
                </Show>
              </Show>
            </div>
          </Show>
        </main>
        <Show when={ctxMenu()}>
          {(m) => (
            <div class="code-ctx" style={{ left: `${m().x}px`, top: `${m().y}px` }}>
              <button type="button" onClick={() => { setFocusRoot(m().path); setCtxMenu(null); }}>Focus this folder</button>
              <Show when={focusRoot()}>
                <button type="button" onClick={() => { setFocusRoot(""); setCtxMenu(null); }}>Clear focus</button>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

function fmtSize(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
