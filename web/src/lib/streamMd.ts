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

const REPARSE_MS = 200; // time cap: how stale the trailing block's formatting may get

export class StreamMd {
  private committedLen = 0; // source chars rendered into finalized (untouched) DOM
  private committedNodes = 0; // host child nodes that are finalized
  private parsedLen = 0; // source chars parsed into the active block's DOM
  private tail: Text | null = null; // plain-text node holding parsedLen..end of the active block
  private inCode = false; // the active block is an (open) fenced code block
  private lastParse = 0;

  constructor(private host: HTMLElement) {}

  reset(): void {
    this.committedLen = 0;
    this.committedNodes = 0;
    this.parsedLen = 0;
    this.tail = null;
    this.inCode = false;
    this.lastParse = 0;
    this.host.textContent = "";
  }

  // Render `text` (a prefix of the full streamed message). `now` is a timestamp
  // (ms) used only for the re-parse time cap; pass performance.now().
  push(text: string, now = 0): void {
    if (text.length < this.committedLen) this.reset();

    // Hot path: extend the active block's plain-text tail in place — one DOM
    // write, no markdown parse, no rebuild. Used until a structural boundary or
    // the time cap makes a real re-parse worthwhile.
    if (this.tail && text.length >= this.parsedLen) {
      const tailText = text.slice(this.parsedLen);
      const added = tailText.slice(this.tail.data.length); // chars since last push
      const boundary = added.includes("\n\n") || (this.inCode && added.includes("```"));
      if (!boundary && now - this.lastParse < REPARSE_MS) {
        this.tail.data = tailText;
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
    this.tail = null;
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
        // The trailing in-progress block: everything up to here is now parsed;
        // drop an empty text node at its end for the hot path to extend.
        this.parsedLen = text.length;
        this.inCode = token.type === "code";
        const end = caretTarget(this.host);
        // marked renders fenced code with a trailing "\n" inside <code>; strip it
        // so appended code continues the line instead of dropping to a new one.
        if (this.inCode && end.lastChild?.nodeType === 3) {
          const t = end.lastChild as Text;
          if (t.data.endsWith("\n")) t.data = t.data.slice(0, -1);
        }
        this.tail = document.createTextNode("");
        end.appendChild(this.tail);
      }
    }
  }
}
