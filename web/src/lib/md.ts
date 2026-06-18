import { marked } from "marked";

// Client-side markdown for the LIVE streaming preview (the settled view still
// uses the server's sanitized/highlighted renderer). Configured to be safe:
// raw HTML in the model's output is dropped, and dangerous URLs neutralized —
// so streaming an assistant reply can't inject markup.
marked.use({ gfm: true, breaks: true, renderer: { html: () => "" } });

export function renderStreamMd(text: string): string {
  let html: string;
  try {
    html = marked.parse(text, { async: false }) as string;
  } catch {
    return "";
  }
  // Defense-in-depth: strip javascript:/data:/vbscript: from href/src.
  return html.replace(/\s(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):[^"']*\2/gi, ' $1="#"');
}
