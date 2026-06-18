import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { oc } from "../api";
import { closeFile, openTarget } from "../files";
import { highlight, langFromPath, listLanguages, splitLines } from "../lib/highlight";
import { loadVersioned, saveVersioned } from "../lib/store";
import FileBadge from "./FileBadge";
import Icon from "./Icon";
import Select from "./Select";

const LS_WRAP = "vh.fileviewer.wrap.v1";

// Read-only file viewer with line numbers, client-side syntax highlighting, a
// language override, and a word-wrap toggle. Jumps to the requested line.
export default function FileViewer() {
  const target = openTarget;
  const [data] = createResource(
    () => target()?.path,
    (path) => oc.get<{ type: string; content: string }>(`/file/content?path=${encodeURIComponent(path)}`),
  );

  // Language: explicit override (signal) falling back to the path's extension.
  const [langOverride, setLangOverride] = createSignal<string>("");
  // Reset the override when a different file opens, so it re-infers from the path.
  createEffect(() => {
    target()?.path;
    setLangOverride("");
  });
  const lang = () => langOverride() || langFromPath(target()?.path || "");

  const [wrap, setWrap] = createSignal<boolean>(
    loadVersioned<boolean>(LS_WRAP, 1, false, (o) => o === 1 || o === "1" || o === true),
  );
  const toggleWrap = () => {
    const v = !wrap();
    setWrap(v);
    saveVersioned(LS_WRAP, 1, v);
  };

  const content = () => (data()?.content || "").replace(/\n$/, "");
  // Highlighted, split into per-line HTML fragments (keeps the gutter + jump).
  const lines = createMemo(() => {
    const c = content();
    if (data.loading) return [];
    const { html } = highlight(c, lang());
    return splitLines(html);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeFile();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  let bodyRef: HTMLDivElement | undefined;
  const scrollToLine = () => {
    const ln = target()?.line;
    if (!ln || !bodyRef) return;
    const el = bodyRef.querySelector(`[data-ln="${ln}"]`);
    el?.scrollIntoView({ block: "center" });
  };

  return (
    <Show when={target()}>
      <div class="dialog-overlay" onClick={closeFile}>
        <div class="dialog fileviewer" role="dialog" aria-label="File" onClick={(e) => e.stopPropagation()}>
          <div class="dialog-head">
            <span class="fv-title">
              <FileBadge path={target()!.path} /> {target()!.path}
              <Show when={target()!.line}>
                <span class="fv-line">:{target()!.line}</span>
              </Show>
            </span>
            <Select
              class="bar-select fv-lang"
              ariaLabel="Highlight language"
              value={lang() || "auto"}
              options={[{ value: "auto", label: "auto" }, ...listLanguages().map((l) => ({ value: l, label: l }))]}
              onChange={(v) => setLangOverride(v)}
            />
            <button
              type="button"
              class="icon-btn fv-wrap"
              classList={{ on: wrap() }}
              aria-label="Toggle word wrap"
              aria-pressed={wrap()}
              data-tip="Toggle word wrap"
              onClick={toggleWrap}
            >
              <Icon name="wrap" />
            </button>
            <button type="button" class="icon-btn" aria-label="Close" onClick={closeFile}>
              <Icon name="x" />
            </button>
          </div>
          <div class="dialog-body fv-body" ref={bodyRef}>
            <Show when={!data.loading} fallback={<div class="placeholder">Loading…</div>}>
              <pre class="fv-code hljs" classList={{ wrap: wrap() }}>
                <For each={lines()}>
                  {(line, i) => (
                    <div
                      class="fv-row"
                      data-ln={i() + 1}
                      classList={{ hl: target()?.line === i() + 1 }}
                      ref={(el) => i() + 1 === target()?.line && queueMicrotask(scrollToLine)}
                    >
                      <span class="fv-ln">{i() + 1}</span>
                      <span class="fv-lc" innerHTML={line || " "} />
                    </div>
                  )}
                </For>
              </pre>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
