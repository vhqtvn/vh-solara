// Placement for the streaming caret: instead of a block-level sibling that drops
// onto its own line after the rendered markdown, the caret is appended at the END
// of the last rendered line — i.e. as the last child of the deepest trailing
// BLOCK element.

// Elements we must NOT descend into: inline text wrappers, void elements, and
// replaced/embedded content. The caret belongs at the end of the last *line*,
// which is the last block element's last child. Descending into a trailing
// inline element (inline <code>, a link, <strong>) would drop the caret INSIDE
// it — mid-line, before any text that follows the inline within the same block.
const STOP = new Set([
  // inline text-level
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DEL", "DFN", "EM",
  "I", "INS", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG",
  "SUB", "SUP", "TIME", "U", "VAR",
  // void / replaced / embedded
  "BR", "WBR", "HR", "IMG", "INPUT", "AREA", "EMBED", "SOURCE", "TRACK", "COL",
  "BUTTON", "SELECT", "TEXTAREA", "LABEL", "SVG", "MATH", "PICTURE", "AUDIO",
  "VIDEO", "CANVAS",
]);

// Append `caret` at the end of the last rendered line within `root`: descend into
// the last child only while it is a block element (so we reach the last <li> of a
// closing list, the last <p>, the <pre> of a fenced block), then append the caret
// as that block's last child — after all of its text and inline content. Trailing
// inline/void elements are not descended into, so the caret never lands mid-line.
export function placeStreamCaret(root: HTMLElement, caret: HTMLElement): void {
  let el: HTMLElement = root;
  while (el.lastElementChild && !STOP.has(el.lastElementChild.tagName)) {
    el = el.lastElementChild as HTMLElement;
  }
  el.appendChild(caret);
}
