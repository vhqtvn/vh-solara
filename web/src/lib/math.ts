// LaTeX math rendering for messages. KaTeX with output:"mathml" emits native
// MathML, which browsers render without any KaTeX stylesheet (CSP-safe, no
// external resources). We post-process server-rendered prose: text nodes are
// scanned for $$…$$ / \[…\] (display) and $…$ / \(…\) (inline) and replaced with
// the rendered MathML, skipping code/links so prices and shell vars are safe.
//
// KaTeX is ~280KB, so it's loaded LAZILY (dynamic import) only the first time a
// message actually contains math — most chats never do, so it stays out of the
// main bundle.
type Katex = (typeof import("katex"))["default"];
let katexP: Promise<Katex> | null = null;
const loadKatex = () => (katexP ??= import("katex").then((m) => m.default));

// $$…$$ | \[…\] (display)  ·  $…$ | \(…\) (inline). Inline $…$ must not begin or
// end with whitespace, so "costs $5 and $10" isn't treated as math.
const MATH_RE =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<!\$)\$(?!\s)((?:[^$\\\n]|\\.)+?)(?<!\s)\$(?!\$)|\\\(([\s\S]+?)\\\)/g;

export function renderMathIn(root: HTMLElement | undefined) {
  if (!root) return;
  // Cheap pre-scan: if there's no math delimiter anywhere, return immediately —
  // and crucially WITHOUT pulling in KaTeX.
  const txt = root.textContent || "";
  if (!txt.includes("$") && !txt.includes("\\(") && !txt.includes("\\[")) return;
  void loadKatex().then((katex) => renderMathSync(root, katex));
}

function renderMathSync(root: HTMLElement, katex: Katex) {
  const renderTex = (tex: string, display: boolean): string => {
    try {
      return katex.renderToString(tex.trim(), { output: "mathml", throwOnError: false, displayMode: display });
    } catch {
      return "";
    }
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.closest("pre,code,a,.katex,.katex-math,.filepath")) return NodeFilter.FILTER_REJECT;
      const v = n.nodeValue || "";
      return v.includes("$") || v.includes("\\(") || v.includes("\\[")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) nodes.push(cur as Text);

  for (const node of nodes) {
    const text = node.nodeValue || "";
    MATH_RE.lastIndex = 0;
    if (!MATH_RE.test(text)) continue;
    MATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = MATH_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const display = m[1] !== undefined || m[2] !== undefined;
      const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
      const html = renderTex(tex, display);
      if (html) {
        const el = document.createElement(display ? "div" : "span");
        el.className = "katex-math";
        el.innerHTML = html; // KaTeX MathML (trusted, client-rendered)
        frag.appendChild(el);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}
