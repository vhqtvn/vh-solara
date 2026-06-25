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

// Line-level markdown (headings, blockquotes, list markers, fenced code), then
// inline highlighting. Drives the composer highlight mirror.
export function highlightInput(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    if (inFence) {
      out.push(`<span class="hl-code">${escHtml(line)}</span>`);
      continue;
    }
    let mm: RegExpExecArray | null;
    if (/^#{1,6}\s/.test(line)) {
      out.push(`<span class="hl-head">${escHtml(line)}</span>`);
    } else if ((mm = /^(\s*>\s?)([\s\S]*)$/.exec(line))) {
      out.push(`<span class="hl-quote">${escHtml(mm[1])}</span>` + inlineHl(mm[2]));
    } else if ((mm = /^(\s*(?:[-*+]|\d+\.)\s)([\s\S]*)$/.exec(line))) {
      out.push(`<span class="hl-marker">${escHtml(mm[1])}</span>` + inlineHl(mm[2]));
    } else {
      out.push(inlineHl(line));
    }
  }
  return out.join("\n") + "\n"; // trailing line so the mirror height matches the textarea
}
