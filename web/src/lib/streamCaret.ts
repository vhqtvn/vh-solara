// Placement for the streaming caret: instead of a block-level sibling that drops
// onto its own line after the rendered markdown, the caret is appended at the END
// of the last rendered line.
//
// We walk down the trailing edge of the content. At each step we look at the last
// element child and decide whether to descend into it or stop and append here:
//   - block element            → descend (reach the last <li>/<p>/<pre>…)
//   - inline text-level element → descend ONLY if no real (non-whitespace) text
//                                  follows it in this element; otherwise stop so
//                                  the caret trails AFTER that text, not inside
//                                  the inline (e.g. inline <code> mid-paragraph).
//   - atomic (void/replaced)    → never descend (can't host a child); trail after
// Descending into a trailing inline that nothing follows is what keeps the caret
// at the end of a fenced code block (<pre><code>…</code></pre>) or a line that
// ends in inline code, rather than parked after the element on its own.

// Inline, text-level elements — they hold text, so the caret may go inside them.
const INLINE = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DEL", "DFN", "EM",
  "I", "INS", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG",
  "SUB", "SUP", "TIME", "U", "VAR", "FONT",
]);

// Void / replaced / embedded / interactive elements: never descend into these —
// the caret trails after them in the parent block.
const ATOMIC = new Set([
  "BR", "WBR", "HR", "IMG", "INPUT", "AREA", "EMBED", "SOURCE", "TRACK", "COL",
  "BUTTON", "SELECT", "TEXTAREA", "LABEL", "OBJECT", "IFRAME",
  "SVG", "MATH", "PICTURE", "AUDIO", "VIDEO", "CANVAS",
]);

// Concatenated text of every node that follows `child` within its parent.
function trailingText(child: Element): string {
  let s = "";
  for (let n: Node | null = child.nextSibling; n; n = n.nextSibling) s += n.textContent || "";
  return s;
}

export function placeStreamCaret(root: HTMLElement, caret: HTMLElement): void {
  let el: HTMLElement = root;
  while (el.lastElementChild) {
    const child = el.lastElementChild as HTMLElement;
    const tag = child.tagName;
    if (ATOMIC.has(tag)) break; // can't host the caret — trail after it
    // An inline element with real text after it: stop, so the caret trails that
    // text. With nothing (or only whitespace) after it, enter it instead.
    if (INLINE.has(tag) && trailingText(child).trim() !== "") break;
    el = child;
  }
  el.appendChild(caret);
}
