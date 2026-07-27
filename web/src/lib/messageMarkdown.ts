// Single shared policy owner for message-markdown rendering.
//
// Both the one-shot fallback (lib/md.ts) and the incremental streaming engine
// (lib/streamMd.ts) used to call `marked.use(...)` on the PACKAGE-GLOBAL
// singleton independently — a mutation hazard. This module owns ONE local
// `Marked` instance with the hardened policy applied once, and both consumers
// import it instead.
//
// Policy (why each piece exists):
//
//   ESCAPE, NEVER DROP raw HTML. The previous policy used `html: () => ""`,
//   which silently dropped raw HTML tokens — so a model emitting `<report>`
//   or `<vh-solara>` syntax produced NOTHING in the rendered view, hiding
//   content from the operator. The escape renderer turns the raw source into
//   visible literal text (`&lt;report&gt;`) so the syntax is always shown.
//
//   walkTokens clears the raw-block `escaped:true` exemption on inner TEXT
//   tokens. In marked 15.0.12 the lexer sets `escaped:true` on Text tokens
//   inside an unterminated raw HTML block, and the default text() renderer
//   then emits them UNESCAPED — leaking raw angle fragments. Clearing the
//   flag forces normal escaping. This is narrowly safe: Text.escaped is ONLY
//   ever set for raw-block inner text in 15.0.12; Code.escaped (legitimate
//   already-escaped code) is a different flag on a different token type and
//   is NOT touched here.
//
//   IMAGE SOURCE CLASSIFIER + custom image renderer. Image markdown in model
//   output can reference arbitrary external URLs — rendering them directly
//   would leak the operator's IP, browser cookies, and reading habits to any
//   third party (a privacy/tracking hazard), and would allow a malicious
//   message to probe the operator's internal network (SSRF via the browser).
//   `classifyImageSrc` routes cross-origin http(s) images through the
//   daemon-side `/vh/img` proxy (which applies its own SSRF gate), leaves
//   same-origin/relative/attachment/raster-data URLs untouched, and
//   neutralizes dangerous or ambiguous sources (javascript:, file:, SVG data
//   URLs, protocol-relative). The custom `renderer.image` applies the
//   classifier so both the one-shot and streaming paths rewrite hrefs BEFORE
//   the HTML string is built (before any browser fetch can fire). The SAME
//   classifier is also applied to detached server-rendered HTML by
//   markdownEnhance.rewriteImageSrcs (called from render.ts before the
//   settled HTML is cached or inserted into the DOM).

import { Marked, type Tokens } from "marked";

// escapeHtml escapes the five XML-mandated characters. Used for raw HTML
// tokens so their original source renders as visible literal text, and for
// HTML attribute values in the image renderer.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Image-source classifier (pure — no DOM dependency).
//
// Returns one of three actions:
//   keep      — leave the src unchanged (safe to fetch directly).
//   proxy     — rewrite to the daemon-side /vh/img proxy (cross-origin http(s)).
//   neutralize— drop the src (dangerous/ambiguous source; no fetch at all).
//
// `selfOrigin` is injectable for unit tests; production reads window.location.
// ---------------------------------------------------------------------------

export type ImageSrcAction =
  | { kind: "keep" }
  | { kind: "proxy"; url: string }
  | { kind: "neutralize" };

// Raster image MIME types permitted in data: URLs. SVG is deliberately absent
// (SVG can carry scripts / external references and is neutralized).
//
// Exported as the SINGLE source of truth for the raster allowlist: the
// pre-render classifier (classifyImageSrc) and the streaming post-render scrub
// (normalizeAttrs) both key off it so a raster data:image/* the operator kept
// at classification time is NOT re-neutralized by the streaming defense-in-depth
// pass. (B1 — defer-streaming-data-image-scrub-divergence.)
export const RASTER_DATA_IMG = /^data:image\/(?:png|jpeg|gif|webp|avif)\b/i;

export function classifyImageSrc(
  src: string | null | undefined,
  selfOrigin?: string,
): ImageSrcAction {
  if (src == null) return { kind: "neutralize" };
  const s = String(src).trim();
  if (s === "") return { kind: "neutralize" };

  // Daemon attachment scheme — always keep (resolved by the daemon itself).
  if (/^vh-attach:/i.test(s)) return { kind: "keep" };

  // data: URLs — allow only specific raster image MIME types.
  if (/^data:/i.test(s)) {
    return RASTER_DATA_IMG.test(s) ? { kind: "keep" } : { kind: "neutralize" };
  }

  // Dangerous / non-fetchable schemes — neutralize.
  if (/^(?:javascript|vbscript|file|blob|ftp):/i.test(s)) return { kind: "neutralize" };

  // Protocol-relative (//host) — ambiguous scheme, neutralize.
  if (s.startsWith("//")) return { kind: "neutralize" };

  // Absolute http(s) URL — same-origin keep, cross-origin proxy.
  if (/^https?:\/\//i.test(s)) {
    const self = selfOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
    if (self) {
      try {
        const u = new URL(s);
        if (u.origin === new URL(self).origin) return { kind: "keep" };
      } catch {
        return { kind: "neutralize" };
      }
    }
    return { kind: "proxy", url: "/vh/img?url=" + encodeURIComponent(s) };
  }

  // Root-relative (/path) or relative (path, ./, ../) — same-origin by
  // definition. Also any token that does not look like a scheme:absolute URL.
  if (s.startsWith("/") || !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return { kind: "keep" };
  }

  // Any other absolute scheme (mailto:, tel:, unknown:) — neutralize for img.
  return { kind: "neutralize" };
}

// messageMarked is the single shared Marked instance for all client-side
// message markdown (one-shot fallback + streaming). It has isolated options
// (no global singleton mutation). Use `.parse`, `.lexer`, and `.parser` on
// this instance — NOT the static `marked.*` functions, which use the global
// default renderer and would silently skip the escape policy.
export const messageMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // ESCAPE raw HTML source as visible literal text instead of dropping it.
    // Both Tokens.HTML (block) and Tokens.Tag (inline) arrive here with the
    // original source in `raw` (and a copy in `text`).
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.raw ?? token.text ?? "");
    },
    // IMAGE renderer: apply the source classifier BEFORE the HTML string is
    // built so the browser never fetches a dangerous/cross-origin URL
    // directly. Cross-origin http(s) → daemon proxy; same-origin/relative/
    // attachment/raster-data → unchanged; everything else → neutralized
    // (img emitted without src so no fetch fires).
    image(token: Tokens.Image): string {
      const action = classifyImageSrc(token.href);
      const alt = escapeHtml(token.text ?? "");
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      switch (action.kind) {
        case "keep":
          return `<img src="${escapeHtml(token.href)}" alt="${alt}"${title}>`;
        case "proxy":
          return `<img src="${escapeHtml(action.url)}" alt="${alt}"${title}>`;
        case "neutralize":
          return `<img alt="${alt}"${title}>`;
      }
    },
  },
  walkTokens(token: Tokens.Text | Token): void {
    // Clear the raw-block escaped exemption on inner text tokens ONLY.
    // Do NOT touch Code.escaped — that is legitimate already-escaped code
    // and must be preserved. Narrowly version-characterized against marked
    // 15.0.12 where Text.escaped is set exclusively for raw-block inner text.
    const t = token as Tokens.Text;
    if (t.type === "text" && t.escaped === true) {
      t.escaped = false;
    }
  },
});

// normalizeAttrs — the post-render defense-in-depth attribute normalizer for
// the STREAMING path (one-shot fallback + incremental streaming engine).
//
// WHY THIS EXISTS (B1 — defer-streaming-data-image-scrub-divergence): both
// streaming callers (md.ts renderStreamMd, streamMd.ts tokenHtml) used to run
// an inline URL_SCRUB regex that neutralized EVERY data: scheme on href/src.
// That scrubber was added as orthogonal defense-in-depth, but it DIVERGED from
// the classifier: classifyImageSrc intentionally KEEPS raster data:image/*
// (operator decision), and the inline scrub silently undid that keep on the
// streaming path (a streamed ![a](data:image/png;base64,...) became src="#").
// The settled path (rewriteImageSrcs) applies the classifier with NO scrub, so
// it was correct — streaming was the lone divergent layer.
//
// O3 fix (unify the policy in ONE place, parameterized by the classifier's own
// raster allowlist). normalizeAttrs mirrors the classifier's keep decision:
//
//   javascript: / vbscript:   — fully neutralized on BOTH href and src
//                               (unchanged from the prior scrub).
//   data: on src              — neutralized UNLESS it is a raster image
//                               (RASTER_DATA_IMG); SVG / non-raster data: on
//                               src still neutralized (matches classifyImageSrc).
//   data: on href             — neutralized UNLESS it is a raster image
//                               (a benign href="data:image/png;..." is kept);
//                               href="data:text/html,..." still neutralized.
//   everything else           — unchanged.
//
// "Neutralize" = rewrite the attribute VALUE to "#", matching the prior scrub's
// visible behavior so a malformed link still renders as a dead "#" (the value is
// replaced, the attribute/quote structure is preserved so the tag stays valid).
// This is defense-in-depth ONLY — the classifier already neutralized dangerous
// img src at render time; this catches any href or stray attribute the renderer
// did not own (links have no custom renderer).
//
// NOTE: this is a regex scrub, not a full HTML parse. It anchors each match on a
// preceding whitespace + the literal attr name + `=`, so it cannot match
// mid-word. This is the SAME surface the prior inline scrub covered; no regression.
const ATTR_DANGER = /\s(href|src)\s*=\s*("|')\s*(javascript|vbscript|data):([^"']*)\2/gi;

export function normalizeAttrs(html: string): string {
  if (!html) return html;
  return html.replace(
    ATTR_DANGER,
    (match, attr: string, _quote: string, scheme: string, value: string) => {
      // A data: URL is kept ONLY when it is a raster image the classifier would
      // also keep (single source of truth: RASTER_DATA_IMG). Reconstruct the
      // "data:<value>" form the allowlist regex expects.
      if (scheme.toLowerCase() === "data" && RASTER_DATA_IMG.test("data:" + value)) {
        return match; // raster image — leave the attribute exactly as-is
      }
      // javascript: / vbscript: on either attr, and non-raster data: (SVG,
      // text/html, application/*, …) on either attr → neutralize to "#".
      return ` ${attr}="#"`;
    },
  );
}

// Re-export the Token type alias so callers don't need a separate import.
type Token = { type?: string };
