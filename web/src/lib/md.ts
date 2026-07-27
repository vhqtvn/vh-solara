import { messageMarked } from "./messageMarkdown";

// Client-side markdown for the LIVE streaming preview (the settled view still
// uses the server's sanitized/highlighted renderer). The shared policy
// (messageMarkdown.ts) ESCAPES raw HTML as visible literal text instead of
// dropping it — so a model emitting `<report>` or `<vh-solara>` syntax shows
// the literal tag, not a silent gap. Dangerous URLs are also neutralized.

export function renderStreamMd(text: string): string {
  let html: string;
  try {
    html = messageMarked.parse(text, { async: false }) as string;
  } catch {
    return "";
  }
  // Defense-in-depth: strip javascript:/data:/vbscript: from href/src.
  return html.replace(/\s(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):[^"']*\2/gi, ' $1="#"');
}
