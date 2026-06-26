import { marked } from "marked";

// Incremental streaming-markdown renderer for the LIVE preview.
//
// Markdown is block-structured: once a blank line (or the next block) follows a
// block, that block is FINAL — its source and its rendering never change again.
// So we render each completed top-level block exactly once and append it, and
// only re-render the trailing in-progress block as characters arrive. Appending
// a character therefore mutates O(active block) of the DOM — not the whole
// (potentially long) message — with no full reparse and no full innerHTML
// rebuild. (The settled view still re-renders server-side: highlighting/mermaid.)
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

export class StreamMd {
  private committedLen = 0; // chars of source rendered into finalized DOM
  private committedNodes = 0; // host child nodes that are finalized (never touched again)

  constructor(private host: HTMLElement) {}

  reset(): void {
    this.committedLen = 0;
    this.committedNodes = 0;
    this.host.textContent = "";
  }

  // Render `text` (a prefix of the full streamed message) incrementally. Safe to
  // call with the same text repeatedly (only the trailing block is rebuilt).
  push(text: string): void {
    // The prefix should only grow; if it shrank/changed under us, start over.
    if (text.length < this.committedLen) this.reset();

    // Drop the previous tick's active-block nodes; finalized nodes (before
    // committedNodes) are never removed.
    while (this.host.childNodes.length > this.committedNodes) this.host.lastChild!.remove();

    let tokens: { raw: string }[];
    try {
      tokens = marked.lexer(text.slice(this.committedLen)) as { raw: string }[];
    } catch {
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
      // Every token but the last is finalized — it can't change anymore.
      if (i < tokens.length - 1) {
        this.committedLen += token.raw.length;
        this.committedNodes = this.host.childNodes.length;
      }
    }
  }
}
