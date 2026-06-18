// Client-side syntax highlighting for the file viewer (highlight.js, common
// language set). We highlight the whole file then split the HTML into per-line
// fragments — re-opening any spans that straddle a newline — so the viewer keeps
// its line-number gutter and jump-to-line while showing highlighted tokens.
import hljs from "highlight.js/lib/common";

export function listLanguages(): string[] {
  return hljs.listLanguages().sort();
}

// Guess a highlight.js language id from a file path's extension/name.
const EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  go: "go", rs: "rust", py: "python", rb: "ruby", java: "java", kt: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", scala: "scala", sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  md: "markdown", markdown: "markdown", html: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less", sql: "sql", lua: "lua", dart: "dart",
  dockerfile: "dockerfile", makefile: "makefile", diff: "diff", patch: "diff",
};
export function langFromPath(path: string): string {
  const file = path.replace(/\/+$/, "").split("/").pop() || "";
  const lower = file.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const lang = EXT[ext];
  return lang && hljs.getLanguage(lang) ? lang : "";
}

// Highlight `code`; "" / "auto" auto-detects. Returns the highlighted HTML and
// the language actually used (for the picker to reflect auto-detection).
export function highlight(code: string, language: string): { html: string; language: string } {
  try {
    if (language && language !== "auto" && hljs.getLanguage(language)) {
      return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
    }
    const r = hljs.highlightAuto(code);
    return { html: r.value, language: r.language || "auto" };
  } catch {
    return { html: escapeHtml(code), language: "auto" };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// Split highlighted HTML into one fragment per source line, carrying open
// <span> tags across line breaks so multi-line tokens (block comments, template
// strings) stay correctly colored on every line.
export function splitLines(highlightedHtml: string): string[] {
  const lines: string[] = [];
  const openStack: string[] = []; // full opening tags, e.g. '<span class="hljs-comment">'
  let cur = "";
  const tagRe = /<\/?span[^>]*>/g;
  let last = 0;
  const text = highlightedHtml;

  const flushNewlines = (chunk: string) => {
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      cur += parts[i];
      if (i < parts.length - 1) {
        // close open spans for this line, push it, reopen for the next line
        cur += "</span>".repeat(openStack.length);
        lines.push(cur);
        cur = openStack.join("");
      }
    }
  };

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    flushNewlines(text.slice(last, m.index)); // text before the tag
    const tag = m[0];
    cur += tag;
    if (tag.startsWith("</")) openStack.pop();
    else openStack.push(tag);
    last = tagRe.lastIndex;
  }
  flushNewlines(text.slice(last));
  lines.push(cur);
  return lines;
}
