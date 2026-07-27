import { messageMarked, normalizeAttrs } from "./messageMarkdown";

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
  // Defense-in-depth: normalizeAttrs strips javascript:/vbscript: from href/src
  // and neutralizes non-raster data: schemes, while KEEPING the raster
  // data:image/* the classifier (classifyImageSrc) intentionally kept. Owned
  // in ONE place (messageMarkdown.ts) so the streaming path cannot diverge
  // from the classifier's keep decision. (B1.)
  return normalizeAttrs(html);
}
