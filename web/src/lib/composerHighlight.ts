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
// A thematic break — three or more of one character, "-", "_" or "*", with
// nothing but spaces and tabs between and around them, and nothing else on
// the line — is no container. From where one starts on a line, the line
// writes no marker: "- - -" is not two nested list items.
//
// A paragraph is what a lazy line continues: a non-blank line that carries
// neither the prefix of the container it sits in nor the start of a block
// keeps that container open. An empty list item — a marker with nothing
// after it but spaces and tabs — starts no container above a paragraph: there
// the marker is paragraph text. An ordered item interrupts a paragraph only
// when it starts at 1; otherwise it is paragraph text in the same way.
//
// Indented code: a non-blank line whose content starts four or more columns
// past the content start of the container it sits in, when no paragraph is
// open there, opens an indented code block. Blank lines and indented lines
// continue it; any other line ends it before itself.
//
// A line that holds only a quote marker — nothing but whitespace behind the
// ">" — is a blank line for what the quote contains.
//
// A fence line: optional leading whitespace (list-nested fences rely on it),
// then a maximal run of ONE fence character, then the rest of the line.
// [1] = the run, [2] = the rest.
const FENCE_RUN = /^\s*(`+|~+)([\s\S]*)$/;
// A blockquote line: optional spaces, ">", at most one space.
const QUOTE = /^(\s*>\s?)([\s\S]*)$/;
// A list-item line: optional spaces, a bullet or an ordered marker (one to
// nine digits, then "." or ")"), then a whitespace character or the end of
// the line — a marker alone on the line is a list item too.
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$))([\s\S]*)$/;
// Both capture the prefix in [1] and the rest of the line in [2].
// The list marker alone, sticky: matched at a scanning position (below).
const MARKER = /[-*+]|\d{1,9}[.)]/y;
// A thematic break on the rest of the line from a scanning position: three or
// more of ONE character — "-", "_" or "*" — with nothing but spaces and tabs
// between them and after them. Mixed characters are not a break: "- * -" is
// a list.
const THEMATIC_BREAK = /^([-_*])(?:[ \t]*\1){2,}[ \t]*$/;
// A setext heading underline on the rest of the line from a scanning
// position: a run of "=" or a run of "-", then nothing but spaces and tabs.
const SETEXT = /^(?:=+|-+)[ \t]*$/;

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
// 3 columns, then at least one whitespace character — or the end of the line:
// a marker alone on the line is an item too, an empty one that starts with a
// blank line. Consumes both and returns the column its content starts at —
// after the marker and the whitespace following it, 5 or more columns of
// which count as 1; one column past a lone marker.
function matchItem(s: Scan): number | null {
  if (s.col - s.base > 3) return null;
  MARKER.lastIndex = s.pos;
  const marker = MARKER.exec(s.line)?.[0];
  if (!marker) return null;
  const bare = s.pos + marker.length === s.line.length;
  if (!bare && !isWs(s.line[s.pos + marker.length])) return null;
  const after = s.col + marker.length; // a marker holds no tabs
  for (let i = marker.length; i > 0; i--) step(s);
  if (bare) {
    s.base = after + 1;
    return after + 1;
  }
  skipWs(s);
  const ws = s.col - after;
  const n = after + (ws >= 5 ? 1 : ws);
  s.base = n;
  return n;
}

// A marker at the scanning position, indented at most 3 columns, followed by
// nothing but spaces and tabs up to the end of the line: an empty list item.
// Consumes nothing.
function bareMarker(s: Scan): boolean {
  if (s.col - s.base > 3) return false;
  MARKER.lastIndex = s.pos;
  const marker = MARKER.exec(s.line)?.[0];
  return !!marker && /^[ \t]*$/.test(s.line.slice(s.pos + marker.length));
}

// An ATX heading at the scanning position: one to six "#", then a space, a
// tab or the end of the line, the "#" indented at most 3 columns. Consumes
// nothing.
function isHeading(s: Scan): boolean {
  if (s.col - s.base > 3) return false;
  return /^#{1,6}(?:[ \t]|$)/.test(s.line.slice(s.pos));
}

// An ordered marker at the scanning position, indented at most 3 columns,
// whose start number is not 1: it cannot interrupt a paragraph. Consumes
// nothing.
function orderedNotFromOne(s: Scan): boolean {
  if (s.col - s.base > 3) return false;
  MARKER.lastIndex = s.pos;
  const marker = MARKER.exec(s.line)?.[0];
  return !!marker && /\d/.test(marker) && !/^0*1[.)]$/.test(marker);
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

// Whether a block can start at the scanning position, so that the line is no
// lazy continuation of a paragraph. False when the rest of the line is
// indented more than 3 columns (indented code never interrupts a paragraph);
// true when it is a heading, a fence, a thematic break or a blockquote, or a
// list item. Consumes nothing.
//
// It runs only for a lazy line, which leaves the innermost container, the one
// holding the paragraph it continues: at the level where it is tested, no
// paragraph is open, so nothing keeps a block from starting. An empty item —
// a marker with nothing after it but spaces and tabs — is a block start
// there, and so is an ordered item whatever number it starts at.
//
// A setext underline is not a block start: a lazy line does not match the
// paragraph's own container, and a line that does not match that container
// cannot underline it.
function startsBlock(s: Scan): boolean {
  if (s.col - s.base > 3) return false;
  const rest = s.line.slice(s.pos);
  if (isHeading(s) || openFence(rest) || THEMATIC_BREAK.test(rest)) return true;
  if (rest[0] === ">") return true;
  if (bareMarker(s)) return true;
  MARKER.lastIndex = s.pos;
  const marker = MARKER.exec(s.line)?.[0];
  if (!marker) return false;
  const after = s.line.slice(s.pos + marker.length);
  return isWs(after[0]) && /\S/.test(after);
}

// A container written at the scanning position: a blockquote level, or a list
// item. Null when the line writes neither — or when a thematic break starts
// there: no marker is recognised behind a break, and no fence either, the rest
// of the line being the break itself. A marker with nothing after it but
// spaces and tabs is an empty item, which cannot interrupt a paragraph, nor
// can an ordered item that does not start at 1: where one is open (`inPara`)
// it is paragraph text, and "text" is returned. Consumes nothing in that
// case.
function written(s: Scan, inPara: boolean): Container | "text" | null {
  if (THEMATIC_BREAK.test(s.line.slice(s.pos))) return null;
  if (matchQuote(s)) return { quote: true };
  if (inPara && (bareMarker(s) || orderedNotFromOne(s))) return "text";
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
  // Whether a paragraph is the innermost open block inside a container: one
  // flag per container, and one more for outside every container — `para[k]`
  // is the paragraph inside container k - 1, `para[0]` the one at top level.
  let para: boolean[] = [false];
  // Whether an indented code block is the innermost open block inside a
  // container, on the same scheme: `icode[k]` is the block inside container
  // k - 1.
  let icode: boolean[] = [false];
  // Blank lines met while an indented code block is open. They are code
  // only if an indented line follows: each is pushed as a plain line and
  // rewritten to a code span when the block continues.
  let pending: { i: number; line: string }[] = [];
  const out: string[] = [];
  const codeSpan = (l: string) => `<span class="hl-code">${escHtml(l)}</span>`;
  // A line rendered with the prefix it carries as a prefix span (a quote
  // prefix or a list marker) and `rest` applied to what follows; a line
  // without a prefix gets `rest` on the whole line.
  const withPrefix = (l: string, rest: (r: string) => string): string => {
    let m: RegExpExecArray | null;
    if ((m = QUOTE.exec(l))) {
      return `<span class="hl-quote">${escHtml(m[1])}</span>` + rest(m[2]);
    }
    if ((m = LIST.exec(l))) {
      return `<span class="hl-marker">${escHtml(m[1])}</span>` + rest(m[2]);
    }
    return rest(l);
  };
  for (const line of lines) {
    // Scan the line through its containers: the block's context inside a
    // block, stopping at the first one the line is not in.
    const s: Scan = { line, pos: 0, col: 0, base: 0 };
    skipWs(s);
    let blank = s.pos === line.length;
    const ctx = fence ? fence.ctx : stack;
    let depth = 0;
    while (depth < ctx.length && inContainer(s, ctx[depth], blank)) {
      depth++;
      // A ">" with nothing behind it is a blank line for what it contains.
      blank = s.pos === line.length;
    }
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
    // the stack is what matched, plus the containers written on this line up
    // to a thematic break.
    fence = null;
    // An indented code block open in the innermost container the line is
    // still in holds the line when the line is blank or indented like the
    // block: an indented line is code, and the blank lines before it inside
    // the block are code too. Any other line ends the block before it.
    if (depth === ctx.length && icode[depth]) {
      if (blank) {
        pending.push({ i: out.length, line });
        out.push(withPrefix(line, inlineHl));
        continue;
      }
      if (s.col - s.base > 3) {
        for (const p of pending) out[p.i] = withPrefix(p.line, codeSpan);
        pending = [];
        out.push(withPrefix(line, codeSpan));
        continue;
      }
      icode[depth] = false;
      pending = [];
    }
    // A lazy line continues the paragraph open inside the innermost container,
    // so the line stays in all of them and writes no block of its own. It is
    // rendered like any line without a block: the prefix it carries — a quote
    // prefix, or a list marker — stays a prefix span, and the rest is inline.
    if (depth < ctx.length && !blank && para[ctx.length] && !startsBlock(s)) {
      let lm: RegExpExecArray | null;
      if ((lm = QUOTE.exec(line))) {
        out.push(`<span class="hl-quote">${escHtml(lm[1])}</span>` + inlineHl(lm[2]));
      } else if ((lm = LIST.exec(line))) {
        out.push(`<span class="hl-marker">${escHtml(lm[1])}</span>` + inlineHl(lm[2]));
      } else {
        out.push(inlineHl(line));
      }
      continue;
    }
    stack = ctx.slice(0, depth);
    // A line that gets this far continues no indented code block: the blank
    // lines it left open stay plain.
    pending = [];
    // A paragraph can be open only in the innermost container the line is
    // still in; none is open inside one the line writes itself. A marker
    // alone where one is open is paragraph text, not an item: `bareText`.
    let bareText = false;
    for (;;) {
      const c = written(s, stack.length === depth ? para[depth] : false);
      if (c === "text") {
        bareText = true;
        break;
      }
      if (!c) break;
      stack = [...stack, c];
    }
    const wasPara = stack.length === depth && para[depth];
    // The rest of the line opens a block unless it is blank or indented code:
    // a fence run indented more than 3 columns past the container content is
    // never a fence. An opener's rest — behind the line's prefix, if it has
    // one — is one code span; otherwise the rendering is as ever.
    const open = blank || s.col - s.base > 3 ? null : openFence(line.slice(s.pos));
    if (open) fence = { ...open, ctx: stack };
    // The line's own content keeps a paragraph open at this level unless it
    // is nothing, a heading, a thematic break, a setext underline closing the
    // paragraph that was open, or indented code — which cannot start a block
    // under an open paragraph, and is a paragraph line there. A break or an
    // underline counts only when the line is not indented: indented four
    // columns or more, it cannot interrupt a paragraph.
    const rest = line.slice(s.pos);
    const indented = s.col - s.base > 3;
    // The line starts an indented code block when its content is indented
    // and no paragraph is open at its level: indented code cannot interrupt
    // a paragraph, and there the line is a paragraph line.
    const ic = !open && !blank && s.pos < line.length && indented && !wasPara;
    const isText =
      !open &&
      s.pos < line.length &&
      !isHeading(s) &&
      !(!indented && THEMATIC_BREAK.test(rest)) &&
      !(!indented && wasPara && SETEXT.test(rest)) &&
      !(indented && !wasPara);
    para = [...para.slice(0, depth), ...stack.slice(depth).map(() => false), isText];
    icode = [...icode.slice(0, depth), ...stack.slice(depth).map(() => false), ic];
    // A block line — a fence opener or an indented-code line — is code,
    // behind its prefix if it has one.
    const block = !!open || ic;
    let mm: RegExpExecArray | null;
    if (!block && /^#{1,6}\s/.test(line)) {
      out.push(`<span class="hl-head">${escHtml(line)}</span>`);
    } else if ((mm = QUOTE.exec(line))) {
      out.push(`<span class="hl-quote">${escHtml(mm[1])}</span>` + (block ? codeSpan(mm[2]) : inlineHl(mm[2])));
    } else if (!bareText && (mm = LIST.exec(line))) {
      out.push(`<span class="hl-marker">${escHtml(mm[1])}</span>` + (block ? codeSpan(mm[2]) : inlineHl(mm[2])));
    } else {
      out.push(block ? codeSpan(line) : inlineHl(line));
    }
  }
  return out.join("\n") + "\n"; // trailing line so the mirror height matches the textarea
}
