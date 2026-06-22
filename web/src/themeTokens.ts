// Theme tokens for embedded views. vh-solara publishes a STABLE, semantic set of
// "--vh-*" custom properties; an embedded/proxied view maps them to its own
// styles so it renders native to vh-solara's look. Generic — no per-consumer
// logic. Internal var names (--bg, --fg-dim, …) can change; the --vh-* names are
// the contract.
//
// Theme is PER-CLIENT (each browser/device has its own). This channel is
// inherently per-client: a client's SPA posts ITS theme to ITS OWN iframe, so
// two clients in different themes each get theirs — the embedded view should
// apply the tokens to its own document (client-side), not assume one global
// theme. (The server's /vh/theme.{json,css} is a client-agnostic default only.)
//
// Delivery:
//   - postMessage to each embedded iframe on load and on every theme/mode change
//     — the ACTUAL active theme (resolved from computed styles), so an operator
//     toggling dark/light restyles the embedded view live, no reload.
//   - the iframe may also request a push: postMessage {source:"vh-solara",
//     type:"theme-request"} to its parent; the SPA replies with the tokens.

// semantic published token  ←  internal CSS var it reads from
export const THEME_TOKENS: { token: string; from: string }[] = [
  { token: "--vh-bg", from: "--bg" },
  { token: "--vh-surface", from: "--bg-2" },
  { token: "--vh-fg", from: "--fg" },
  { token: "--vh-muted", from: "--fg-dim" },
  { token: "--vh-accent", from: "--accent" },
  { token: "--vh-accent-2", from: "--accent-2" },
  { token: "--vh-border", from: "--border" },
  { token: "--vh-ok", from: "--ok" },
  { token: "--vh-warn", from: "--warn" },
  { token: "--vh-error", from: "--danger" },
];

export interface ThemePayload {
  source: "vh-solara";
  type: "theme";
  mode: "light" | "dark";
  tokens: Record<string, string>;
}

// Resolve the ACTIVE theme's tokens from the live computed styles (so it reflects
// any built-in/custom theme + light/dark, not a static default).
export function resolveThemeTokens(): { mode: "light" | "dark"; tokens: Record<string, string> } {
  const cs = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const { token, from } of THEME_TOKENS) tokens[token] = cs.getPropertyValue(from).trim();
  // applyTheme() toggles this class for every light theme (built-in or custom).
  const mode = document.documentElement.classList.contains("theme-light-scoped") ? "light" : "dark";
  return { mode, tokens };
}

// Post the current theme to a specific window (an iframe's contentWindow).
export function postThemeTo(win: Window | null) {
  if (!win) return;
  const { mode, tokens } = resolveThemeTokens();
  const msg: ThemePayload = { source: "vh-solara", type: "theme", mode, tokens };
  try {
    win.postMessage(msg, "*"); // tokens are non-secret theme values
  } catch {
    /* window gone */
  }
}

// Push the current theme to every mounted embedded-view iframe (call on change).
export function broadcastTheme() {
  document
    .querySelectorAll<HTMLIFrameElement>("iframe.view-frame")
    .forEach((f) => postThemeTo(f.contentWindow));
}
