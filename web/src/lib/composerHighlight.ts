// Composer syntax highlighting: turns the textarea's text into color-only HTML
// for the mirror layer behind it. Color-only spans (no font/size/weight/padding
// changes) so glyph advances match the textarea exactly and the caret never
// drifts. Pure functions — extracted from ChatView so the component stays about
// behaviour, not string munging.

const escHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

// Inline markdown + token highlighting for one line.
// Precedence: code > link > bold > italic > strike > command > mention > path.
function inlineHl(s: string): string {
  const re =
    /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(~~[^~\n]+~~)|((?:^|\s)[!/][\w-]+)|(@[\w./-]+)|([\w.\-]+\/[\w.\-/]*\.[A-Za-z]\w{0,7})/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += escHtml(s.slice(last, m.index));
    const tok = m[0];
    const cls = m[1]
      ? "hl-code"
      : m[2]
        ? "hl-link"
        : m[3]
          ? "hl-strong"
          : m[4]
            ? "hl-em"
            : m[5]
              ? "hl-strike"
              : m[6]
                ? "hl-cmd"
                : m[7]
                  ? "hl-mention"
                  : "hl-path";
    if (m[6] && /^\s/.test(tok)) {
      out += escHtml(tok[0]) + `<span class="${cls}">${escHtml(tok.slice(1))}</span>`;
    } else {
      out += `<span class="${cls}">${escHtml(tok)}</span>`;
    }
    last = m.index + tok.length;
  }
  return out + escHtml(s.slice(last));
}

// Fenced code blocks (CommonMark): the opener's fence character and run length
// are remembered, and ONLY a run of that character, at least as long, followed
// by nothing but whitespace closes the block. So three backticks are plain
// content inside a four-backtick block.
//
// An opener may also sit behind container prefixes — blockquote markers and
// list markers, combined or nested ("> - ```", ">>", a quote inside a list
// item). The block belongs to those containers: it ends when one of them ends,
// even without a closer line, and a closer must sit behind the same prefixes.
//
// Each of them — a fence run, a list marker, a ">" — may be indented at most
// 3 columns, counted from the start of the content of the container it sits
// in. More makes it indented code: never a fence.
//
// A fence line: optional leading whitespace (list-nested fences rely on it),
// then a maximal run of ONE fence character, then the rest of the line.
// [1] = the run, [2] = the rest.
const FENCE_RUN = /^\s*(`+|~+)([\s\S]*)$/;
// A blockquote line: optional spaces, ">", at most one space.
const QUOTE = /^(\s*>\s?)([\s\S]*)$/;
// A list-item line: optional spaces, a bullet or "digits.", one space.
const LIST = /^(\s*(?:[-*+]|\d+\.)\s)([\s\S]*)$/;
// Both capture the prefix in [1] and the rest of the line in [2].
// The list marker alone, sticky: matched at a scanning position (below).
const MARKER = /[-*+]|\d+\./y;

// A container a line can sit in: a blockquote level, or a list item whose
// content starts at column `n`.
type Container = { quote: true } | { quote: false; n: number };

// The open fence: the opener's character and run length, and the containers
// the opener line sat in, outermost first.
type Fence = { ch: string; len: number; ctx: Container[] };

// Opening fence (outside a block): at least 3 of one fence character. A
// backtick fence's info string must not contain another backtick — such a line
// is ordinary text, not a fence. Returns the fence character and run length.
function openFence(line: string): { ch: string; len: number } | null {
  const m = FENCE_RUN.exec(line);
  if (!m || m[1].length < 3) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { ch: m[1][0], len: m[1].length };
}

// Closing fence for `fence`: a run of at least `len` of its character, then
// only whitespace to end of line. Tested on the text behind the block's
// container prefixes, so a line outside those containers never closes it.
function isCloseFence(line: string, fence: Fence): boolean {
  const m = FENCE_RUN.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s*$/.test(m[2]);
}

// One line's scan through its container prefixes. `pos` is the index of the
// next unconsumed character — always the next non-whitespace character, or the
// end of the line — and `col` its column: one per character, except that a
// tab advances to the next multiple of 4. `base` is the content start column
// of the innermost container matched so far (0 with none): whatever comes
// next on the line is indented `col - base` columns.
type Scan = { line: string; pos: number; col: number; base: number };

const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

// Consumes one character.
function step(s: Scan): void {
  s.col = s.line[s.pos] === "\t" ? (Math.floor(s.col / 4) + 1) * 4 : s.col + 1;
  s.pos++;
}

// Consumes the whitespace at the scanning position.
function skipWs(s: Scan): void {
  while (isWs(s.line[s.pos])) step(s);
}

// A blockquote level written at the scanning position: ">", indented at most
// 3 columns, then at most one whitespace character. Consumes both; the rest
// of the line is its content, measured from after them.
function matchQuote(s: Scan): boolean {
  if (s.line[s.pos] !== ">" || s.col - s.base > 3) return false;
  step(s);
  if (isWs(s.line[s.pos])) step(s);
  s.base = s.col;
  skipWs(s);
  return true;
}

// A list item written at the scanning position: the marker, indented at most
// 3 columns, then at least one whitespace character. Consumes both and
// returns the column its content starts at — after the marker and the
// whitespace following it, 5 or more columns of which count as 1.
function matchItem(s: Scan): number | null {
  if (s.col - s.base > 3) return null;
  MARKER.lastIndex = s.pos;
  const marker = MARKER.exec(s.line)?.[0];
  if (!marker || !isWs(s.line[s.pos + marker.length])) return null;
  const after = s.col + marker.length; // a marker holds no tabs
  for (let i = marker.length; i > 0; i--) step(s);
  skipWs(s);
  const ws = s.col - after;
  const n = after + (ws >= 5 ? 1 : ws);
  s.base = n;
  return n;
}

// Whether the line continues the container `c` from the scanning position. A
// blockquote level consumes its marker. A list item holds a blank line, or a
// line whose first non-whitespace character past what was consumed sits at or
// past the item's content column; it consumes nothing. Either way the
// container's content start becomes the base.
function inContainer(s: Scan, c: Container, blank: boolean): boolean {
  if (c.quote) return matchQuote(s);
  if (!blank && s.col < c.n) return false;
  s.base = c.n;
  return true;
}

// A container written at the scanning position: a blockquote level, or a list
// item. Null when the line writes neither.
function written(s: Scan): Container | null {
  if (matchQuote(s)) return { quote: true };
  const n = matchItem(s);
  return n === null ? null : { quote: false, n };
}

// Line-level markdown (headings, blockquotes, list markers, fenced code), then
// inline highlighting. Drives the composer highlight mirror.
export function highlightInput(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  // The open fence, or null outside a block.
  let fence: Fence | null = null;
  // The containers a line outside a block sits in, outermost first. They carry
  // over from line to line; a line ends those it is not in.
  let stack: Container[] = [];
  const out: string[] = [];
  const codeSpan = (l: string) => `<span class="hl-code">${escHtml(l)}</span>`;
  for (const line of lines) {
    // Scan the line through its containers: the block's context inside a
    // block, stopping at the first one the line is not in.
    const s: Scan = { line, pos: 0, col: 0, base: 0 };
    skipWs(s);
    const blank = s.pos === line.length;
    const ctx = fence ? fence.ctx : stack;
    let depth = 0;
    while (depth < ctx.length && inContainer(s, ctx[depth], blank)) depth++;
    if (fence && depth === ctx.length) {
      // Inside the block: everything is content except a valid closer, which
      // ends the block after this line.
      if (s.col - s.base <= 3 && isCloseFence(line.slice(s.pos), fence)) {
        fence = null;
        stack = ctx;
      }
      out.push(codeSpan(line));
      continue;
    }
    // Outside a block (a block whose container ended ends before this line):
    // the stack is what matched, plus the containers written on this line.
    fence = null;
    stack = ctx.slice(0, depth);
    for (let c = written(s); c; c = written(s)) stack = [...stack, c];
    // The rest of the line opens a block unless it is blank or indented code:
    // a fence run indented more than 3 columns past the container content is
    // never a fence. An opener's rest — behind the line's prefix, if it has
    // one — is one code span; otherwise the rendering is as ever.
    const open = blank || s.col - s.base > 3 ? null : openFence(line.slice(s.pos));
    if (open) fence = { ...open, ctx: stack };
    let mm: RegExpExecArray | null;
    if (!open && /^#{1,6}\s/.test(line)) {
      out.push(`<span class="hl-head">${escHtml(line)}</span>`);
    } else if ((mm = QUOTE.exec(line))) {
      out.push(`<span class="hl-quote">${escHtml(mm[1])}</span>` + (open ? codeSpan(mm[2]) : inlineHl(mm[2])));
    } else if ((mm = LIST.exec(line))) {
      out.push(`<span class="hl-marker">${escHtml(mm[1])}</span>` + (open ? codeSpan(mm[2]) : inlineHl(mm[2])));
    } else {
      out.push(open ? codeSpan(line) : inlineHl(line));
    }
  }
  return out.join("\n") + "\n"; // trailing line so the mirror height matches the textarea
}
