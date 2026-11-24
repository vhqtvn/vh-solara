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
// An opener may also sit behind a container prefix — a blockquote marker or a
// list marker — and is tested on the rest of that line. One behind a blockquote
// marker closes only behind a blockquote marker again.
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

// The open fence: the opener's character and run length, and whether the opener
// sat on a blockquote line.
type Fence = { ch: string; len: number; quoted: boolean };

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
// only whitespace to end of line. A block opened on a blockquote line closes
// only on a blockquote line — the same prefix is stripped first, and a bare
// fence line is content. Any other block closes on the bare run alone, so a
// ">" line inside it is content.
function isCloseFence(line: string, fence: Fence): boolean {
  let rest = line;
  if (fence.quoted) {
    const q = QUOTE.exec(line);
    if (!q) return false;
    rest = q[2];
  }
  const m = FENCE_RUN.exec(rest);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len && /^\s*$/.test(m[2]);
}

// The rest of a container line (behind a blockquote or list marker): a code
// span that opens a fence, or inline highlighting. Also returns the fence it
// opened, if any.
function afterPrefix(rest: string, quoted: boolean): { html: string; fence: Fence | null } {
  const open = openFence(rest);
  if (!open) return { html: inlineHl(rest), fence: null };
  return { html: `<span class="hl-code">${escHtml(rest)}</span>`, fence: { ...open, quoted } };
}

// Line-level markdown (headings, blockquotes, list markers, fenced code), then
// inline highlighting. Drives the composer highlight mirror.
export function highlightInput(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  // The open fence, or null outside a block.
  let fence: Fence | null = null;
  const out: string[] = [];
  for (const line of lines) {
    if (fence) {
      // Inside a block: everything is content except a valid closer.
      if (isCloseFence(line, fence)) fence = null;
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    const open = openFence(line);
    if (open) {
      fence = { ...open, quoted: false };
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    let mm: RegExpExecArray | null;
    if (/^#{1,6}\s/.test(line)) {
      out.push(`<span class="hl-head">${escHtml(line)}</span>`);
    } else if ((mm = QUOTE.exec(line))) {
      const tail = afterPrefix(mm[2], true);
      fence = tail.fence;
      out.push(`<span class="hl-quote">${escHtml(mm[1])}</span>` + tail.html);
    } else if ((mm = LIST.exec(line))) {
      const tail = afterPrefix(mm[2], false);
      fence = tail.fence;
      out.push(`<span class="hl-marker">${escHtml(mm[1])}</span>` + tail.html);
    } else {
      out.push(inlineHl(line));
    }
  }
  return out.join("\n") + "\n"; // trailing line so the mirror height matches the textarea
}
