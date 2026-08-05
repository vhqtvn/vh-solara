// Non-streaming markdown enhancement helpers extracted from components/Part.tsx
// (TS refactor slice 1). Each of these transforms/augments rendered markdown
// content and NONE participates in the live streaming render loop (FRAME_MS=200
// coalesce / StreamMd.push). They are pure DOM/string utilities with no SolidJS
// or component dependencies, so they live here next to the other markdown
// helpers (md.ts, streamMd.ts, math.ts, mermaid.ts).
//
// The live streaming invariants (GPU-heat: no scroll-container masks, no
// backdrop-filter:blur, no per-element contain/content-visibility, capped render
// rate, append-only growing nodes) are unaffected by anything in this module —
// these helpers run once on settled (server-rendered) HTML or on a one-shot
// client fallback, never inside the per-frame streaming path.

import { looksLikePath } from "./pathlike";
import { classifyImageSrc } from "./messageMarkdown";
import { codeRawUrl } from "../code/api";

// Linkify file paths (containing "/" + an extension, optional :line) in
// rendered prose so they jump to the file. Skips code/links.
export function linkifyPaths(root: HTMLElement | undefined) {
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
export function tagInlineCodePaths(root: HTMLElement | undefined) {
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
// Exported so the copy-button regression test can drive the real wiring against
// a manually-built chroma-envelope DOM (see tests/unit/codeCopy.test.ts).
export function addCodeCopyButtons(root: HTMLElement | undefined) {
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
      // Server-rendered (chroma) code blocks wrap each source line in
      // `<span class="line"><span class="cl">…\n</span></span>`, and the chroma
      // stylesheet makes `.line` display:flex (block-level). Element.innerText
      // is CSS-box-aware and would insert an EXTRA line break at each block
      // boundary on top of the `\n` already inside .cl, producing blank lines
      // between every copied line. textContent is not CSS-aware and reproduces
      // the source verbatim — which is what copy should do.
      void navigator.clipboard?.writeText((code ?? pre).textContent ?? "");
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
export function splitMermaid(text: string): { type: "md" | "mermaid"; content: string }[] {
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

// Rewrite every <img src> in an HTML STRING through the image-source
// classifier, BEFORE the string is inserted into the live DOM.
//
// Why string-in / string-out (not operate on a mounted root): once an <img>
// is in the live DOM with a foreign src, the browser fires the fetch
// immediately — rewriting after insertion is too late. The caller (render.ts)
// invokes this on the detached /vh/render response before caching or returning
// it to Part.tsx, so the src the browser eventually sees is already corrected.
//
// Safety: parsing uses a <template> element whose content is inert by the HTML
// spec — no resource loads, no script execution. This is cheaper than DOMParser
// and sufficient for rewriting attribute values. A fast-path skips parsing
// entirely when the string has no <img tag.
export function rewriteImageSrcs(html: string): string {
  if (!html || !html.includes("<img")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const imgs = tpl.content.querySelectorAll("img");
  imgs.forEach((img) => {
    // getAttribute returns the raw (entity-decoded) attribute value; the
    // classifier sees the actual URL the browser would fetch.
    const raw = img.getAttribute("src");
    if (raw == null) return; // img without src — already neutralized or structural
    const action = classifyImageSrc(raw);
    if (action.kind === "keep") return;
    if (action.kind === "proxy") {
      img.setAttribute("src", action.url);
    } else if (action.kind === "projectFile") {
      // Project-relative path (e.g. .vh-solara/.../attachments/x.png) → daemon
      // /vh/code/raw URL. The daemon serves the bytes (same-origin, contained,
      // requires an open project); the raw src would otherwise 404 against the
      // SPA document origin.
      img.setAttribute("src", codeRawUrl(action.path));
    } else {
      // neutralize: remove src so no fetch fires. Keep alt for accessibility.
      img.removeAttribute("src");
    }
  });
  return tpl.innerHTML;
}
