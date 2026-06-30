import { marked } from "marked";
import { caretTarget } from "./streamCaret";

// Incremental streaming-markdown renderer for the LIVE preview.
//
// Two levels of incrementality, so appending a character is O(delta), never
// O(message) — which is what pinned the CPU before (re-parsing + rebuilding the
// whole trailing block every frame is O(n) per frame → O(n²) over a stream,
// brutal for a long single block / code block / list):
//
//   1. Completed top-level BLOCKS are final (a blank line / next block followed
//      them): rendered once, appended, and never touched again.
//   2. The trailing IN-PROGRESS block isn't rebuilt per character. New text is
//      appended to a single plain-text node at its end (one DOM write). A real
//      markdown re-parse of that block happens only on a structural boundary —
//      a blank line, or a code-fence close — or a ~200ms time cap. So inline
//      formatting (bold, links) settles within a frame or two, while the hot
//      path (typing into the current block) costs one string assignment.
//
// (The settled view still re-renders server-side: highlighting / mermaid.)
//
// Same safe config as the one-shot renderer: raw HTML dropped, dangerous URLs
// neutralized — a streamed reply can't inject markup.
marked.use({ gfm: true, breaks: true, renderer: { html: () => "" } });
const URL_SCRUB = /\s(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):[^"']*\2/gi;

function tokenHtml(token: unknown): string {
  let html: string;
  try {
    html = marked.parser([token as never], { async: false }) as string;
  } catch {
    return "";
  }
  return html.replace(URL_SCRUB, ' $1="#"');
}

// Time cap for re-parsing the trailing block. A re-parse re-renders that block's
// HTML (re-innerHTML), which repaints it and clobbers any text selection inside —
// so we want it RARE. Block boundaries (blank line / fence close) still re-parse
// immediately and finalize+format the block, so this cap only governs an
// un-terminated block (a long paragraph/list/code still streaming): its inline
// markdown stays raw for at most this long before formatting. 5s ≫ the 200ms it
// was, cutting active-block repaints ~25× while almost every block formats at its
// boundary well before the cap fires.
const REPARSE_MS = 5000;

export class StreamMd {
  private committedLen = 0; // source chars rendered into finalized (untouched) DOM
  private committedNodes = 0; // host child nodes that are finalized
  private parsedLen = 0; // source chars parsed into the active block's DOM
  private tailHost: HTMLElement | null = null; // active block element to append the tail into
  private tailLen = 0; // raw chars appended after parsedLen (the not-yet-reparsed tail)
  private inCode = false; // the active block is an (open) fenced code block
  private lastParse = 0;

  constructor(private host: HTMLElement) {}

  reset(): void {
    this.committedLen = 0;
    this.committedNodes = 0;
    this.parsedLen = 0;
    this.tailHost = null;
    this.tailLen = 0;
    this.inCode = false;
    this.lastParse = 0;
    this.host.textContent = "";
  }

  // Render `text` (a prefix of the full streamed message). `now` is a timestamp
  // (ms) used only for the re-parse time cap; pass performance.now(). `force`
  // bypasses that cap once (tab-resume snap) so inline formatting settles with
  // the raw text instead of up to REPARSE_MS later; steady state never sets it.
  push(text: string, now = 0, force = false): void {
    if (text.length < this.committedLen) this.reset();

    // Hot path: APPEND the new characters as a fresh text node — never rewrite
    // existing text. Rewriting the tail node (tail.data = …) re-shapes and
    // re-rasterizes the whole growing block every update (O(block) → O(n²),
    // measured ~25× more raster); appending a new node only paints the new run.
    // Used until a structural boundary or the time cap forces a real re-parse.
    if (this.tailHost && text.length >= this.parsedLen + this.tailLen) {
      const delta = text.slice(this.parsedLen + this.tailLen);
      const boundary = delta.includes("\n\n") || (this.inCode && delta.includes("```"));
      if (!force && !boundary && now - this.lastParse < REPARSE_MS) {
        if (delta) {
          this.tailHost.appendChild(document.createTextNode(delta));
          this.tailLen += delta.length;
        }
        return;
      }
    }
    this.reparse(text, now);
  }

  // Where the caret should trail (end of the last rendered line) — the engine
  // puts its tail node here too, so the caret sits just after it.
  get caretHost(): HTMLElement {
    return caretTarget(this.host);
  }

  private reparse(text: string, now: number): void {
    this.lastParse = now;
    this.tailHost = null;
    this.tailLen = 0;
    // Drop the (re-rendered) active block; finalized nodes are kept.
    while (this.host.childNodes.length > this.committedNodes) this.host.lastChild!.remove();

    let tokens: { raw: string; type?: string }[];
    try {
      tokens = marked.lexer(text.slice(this.committedLen)) as { raw: string; type?: string }[];
    } catch {
      return;
    }
    if (tokens.length === 0) {
      this.parsedLen = this.committedLen;
      this.inCode = false;
      return;
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const html = tokenHtml(token);
      if (html) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html;
        this.host.append(...Array.from(tpl.content.childNodes));
      }
      if (i < tokens.length - 1) {
        // Finalized — this block can't change anymore.
        this.committedLen += token.raw.length;
        this.committedNodes = this.host.childNodes.length;
      } else {
        // The trailing in-progress block: everything up to here is now parsed.
        // The hot path appends further characters as text nodes into `tailHost`.
        this.parsedLen = text.length;
        this.tailLen = 0;
        this.inCode = token.type === "code";
        const end = caretTarget(this.host);
        // marked renders fenced code with a trailing "\n" inside <code>; strip it
        // so appended code continues the line instead of dropping to a new one.
        if (this.inCode && end.lastChild?.nodeType === 3) {
          const t = end.lastChild as Text;
          if (t.data.endsWith("\n")) t.data = t.data.slice(0, -1);
        }
        this.tailHost = end;
      }
    }
  }
}
