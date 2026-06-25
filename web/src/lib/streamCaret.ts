// Placement for the streaming caret: instead of a block-level sibling that drops
// onto its own line after the rendered markdown, the caret is appended INTO the
// deepest trailing element so it trails the text at the end of the last line.

// Void/replaced elements that can't host the caret as a child — the descent
// stops at their parent and the caret is appended after them there.
const CARET_VOID = new Set(["IMG", "HR", "BR", "INPUT", "AREA", "EMBED", "SOURCE", "TRACK", "WBR", "COL"]);

// Append `caret` at the end of the last rendered line within `root`: descend into
// the deepest trailing element (e.g. the last <li> of a closing list, the last
// <p>, the <code> of a fenced block) and append the caret there. If the trailing
// element is void/replaced (an image, rule), stop at its parent so the caret sits
// just after it. With no descendable child, the caret trails at the root.
export function placeStreamCaret(root: HTMLElement, caret: HTMLElement): void {
  let el: HTMLElement = root;
  while (el.lastElementChild && !CARET_VOID.has(el.lastElementChild.tagName)) {
    el = el.lastElementChild as HTMLElement;
  }
  el.appendChild(caret);
}
