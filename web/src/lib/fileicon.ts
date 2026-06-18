// File-type identity: a short extension label + a language color, rendered as a
// crisp badge (see FileBadge) instead of cross-platform emoji.
const COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#d9b400", jsx: "#d9b400", mjs: "#d9b400", cjs: "#d9b400",
  go: "#00add8", py: "#4b8bbe", rs: "#dea584", rb: "#cc342d", java: "#b07219",
  c: "#8a99a8", h: "#8a99a8", cpp: "#f34b7d", cc: "#f34b7d", cs: "#3f9142",
  php: "#7e8bc4", swift: "#f05138", kt: "#a97bff",
  json: "#cbcb41", jsonc: "#cbcb41", toml: "#b0834d", yml: "#e0573a", yaml: "#e0573a", ini: "#8a99a8",
  md: "#519aba", mdx: "#519aba", txt: "#9aa4b2", css: "#9a76d8", scss: "#c6538c", html: "#e34c26",
  sh: "#89e051", bash: "#89e051", zsh: "#89e051", sql: "#e38c00",
  svg: "#ff9800", png: "#c08bd0", jpg: "#c08bd0", jpeg: "#c08bd0", gif: "#c08bd0",
  lock: "#8b949e", dockerfile: "#0db7ed",
};

export function fileExt(path: string): string {
  const base = (path.split("/").pop() || path).toLowerCase();
  if (base === "dockerfile") return "dok";
  const ext = base.includes(".") ? base.split(".").pop() || "" : "";
  return (ext || "·").slice(0, 4);
}

export function fileColor(path: string): string {
  const base = (path.split("/").pop() || path).toLowerCase();
  if (base === "dockerfile") return COLORS.dockerfile;
  const ext = base.split(".").pop() || "";
  return COLORS[ext] || "var(--fg-dim)";
}
