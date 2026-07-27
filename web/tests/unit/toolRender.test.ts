// @vitest-environment jsdom
//
// Characterization tests for the tool-rendering helpers extracted from
// components/Part.tsx (TS refactor slice 2). These lock the new
// components/ToolPart.tsx seam by asserting the EXACT current behavior of the
// pure helpers ToolPart consumes: the tool-output → markdown-fence classifiers
// (jsonPretty / looksXML, which drive ToolBody's fence-vs-plain decision) and
// the tool-name → Icon-glyph mapping (toolIconName, which drives the head icon).
//
// The component behavior (ToolBody / ToolPart) is already characterized through
// the PartView dispatcher by PartTool.test.tsx (live duration) and
// PartToolAction.test.tsx (open-file keyboard action); this file covers the
// three pure helpers that had NO direct coverage inside Part.tsx.
//
// Behavior-preserving extraction: these tests pin what the functions already did
// inside Part.tsx so a future refactor of the seam cannot silently shift it.
//
// jsdom doesn't implement matchMedia, but importing ToolPart pulls in
// ./Part → code/frame → layout, which calls window.matchMedia at module load
// (the same chain PartTool.test.tsx stubs). Install a minimal stub BEFORE the
// component import is evaluated (vi.hoisted runs ahead of static imports).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});
import { describe, expect, it, vi } from "vitest";
import { jsonPretty, looksXML, toolIconName } from "../../src/components/ToolPart";

// ---- jsonPretty ----------------------------------------------------------
// Detects object/array-shaped strings and returns 2-space pretty JSON so ToolBody
// can fence them as ```json for server-side syntax highlighting. Returns null for
// anything that isn't a JSON object/array (scalars, malformed JSON, other text)
// so ToolBody falls through to the plain <pre> path.
describe("jsonPretty", () => {
  it("pretty-prints a flat object with 2-space indent", () => {
    expect(jsonPretty('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("pretty-prints an array", () => {
    expect(jsonPretty("[1,2,3]")).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("indents nested structures", () => {
    expect(jsonPretty('{"a":{"b":2}}')).toBe('{\n  "a": {\n    "b": 2\n  }\n}');
  });

  it("trims surrounding whitespace before parsing", () => {
    // Tool output often has leading/trailing whitespace; the classifier trims so
    // a padded JSON blob is still recognized and fenced.
    expect(jsonPretty('  {"a":1}\n')).toBe('{\n  "a": 1\n}');
  });

  it("returns the compact form for an empty object", () => {
    expect(jsonPretty("{}")).toBe("{}");
  });

  it("returns the compact form for an empty array", () => {
    expect(jsonPretty("[]")).toBe("[]");
  });

  it("re-normalizes key order / spacing of already-printed JSON", () => {
    // JSON.parse drops the original formatting; stringify re-emits canonical
    // 2-space form regardless of input spacing.
    expect(jsonPretty('{  "a" : 1 }')).toBe('{\n  "a": 1\n}');
  });

  it("returns null for a JSON scalar that is not an object/array (no { or [ prefix)", () => {
    // The {/[ prefix gate means bare strings/numbers aren't fenced as JSON even
    // though they're valid JSON — ToolBody shows them as plain text.
    expect(jsonPretty('"just a string"')).toBeNull();
    expect(jsonPretty("42")).toBeNull();
    expect(jsonPretty("true")).toBeNull();
    expect(jsonPretty("null")).toBeNull();
  });

  it("returns null for non-JSON text", () => {
    expect(jsonPretty("not json at all")).toBeNull();
  });

  it("returns null for malformed JSON that starts with { or [ but fails to parse", () => {
    expect(jsonPretty("{not closed")).toBeNull();
    expect(jsonPretty("[1,2,")).toBeNull();
    expect(jsonPretty("{,}")).toBeNull();
  });
});

// ---- looksXML ------------------------------------------------------------
// Detects XML-shaped tool output so ToolBody can fence it as ```xml. Requires a
// tag-like opening (< + letter/?/!) AND a closing tag at the end; both gates
// must pass so plain text or fragments don't get mis-fenced.
describe("looksXML", () => {
  it("recognizes a simple element with a closing tag", () => {
    expect(looksXML("<foo>bar</foo>")).toBe(true);
  });

  it("trims surrounding whitespace before testing", () => {
    expect(looksXML("  <foo>bar</foo>\n")).toBe(true);
  });

  it("recognizes an XML declaration followed by a root element", () => {
    // The opening gate allows <? (the `?` in the char class) for <?xml ...?>.
    expect(looksXML('<?xml version="1.0"?><root></root>')).toBe(true);
  });

  it("recognizes a DOCTYPE + html document", () => {
    // The opening gate allows <! (the `!` in the char class) for <!DOCTYPE>.
    expect(looksXML("<!DOCTYPE html><html></html>")).toBe(true);
  });

  it("recognizes hyphenated tag names in the closing tag", () => {
    expect(looksXML("<a-b>x</a-b>")).toBe(true);
  });

  it("recognizes namespaced (colon) tag names in the closing tag", () => {
    expect(looksXML("<a:b>x</a:b>")).toBe(true);
  });

  it("returns false for plain text (no tag opener)", () => {
    expect(looksXML("not xml")).toBe(false);
  });

  it("returns false for an opener with no closing tag", () => {
    expect(looksXML("<only-open>")).toBe(false);
  });

  it("returns false when leading text precedes the first tag", () => {
    expect(looksXML("text <foo>bar</foo>")).toBe(false);
  });

  it("returns false when trailing text follows the closing tag", () => {
    // The closing-tag anchor requires \\s*$ — trailing non-whitespace fails it.
    expect(looksXML("<foo>bar</foo> tail")).toBe(false);
  });

  it("returns false when the opener's first char is a digit (not a tag name)", () => {
    expect(looksXML("<123>")).toBe(false);
  });
});

// ---- toolIconName --------------------------------------------------------
// Maps a tool name to one of the Icon glyphs (see Icon.tsx). Case-insensitive
// substring match, first branch wins. Pins the full mapping incl. the ordering
// (e.g. a tool name containing both "write" and "todo" takes the edit/write
// branch, not the todo branch) so a future reorder can't silently shift icons.
describe("toolIconName", () => {
  it("maps edit/write/patch/create/str_replace tools to 'edit'", () => {
    expect(toolIconName("edit")).toBe("edit");
    expect(toolIconName("write")).toBe("edit");
    expect(toolIconName("str_replace")).toBe("edit");
    expect(toolIconName("create_file")).toBe("edit");
  });

  it("maps bash/shell/cmd/terminal tools to 'terminal'", () => {
    expect(toolIconName("bash")).toBe("terminal");
    expect(toolIconName("execute_bash")).toBe("terminal");
  });

  it("maps read/view/cat tools to 'eye'", () => {
    expect(toolIconName("read")).toBe("eye");
    expect(toolIconName("view")).toBe("eye");
  });

  it("maps grep/search/find/glob/ripgrep tools to 'filter'", () => {
    expect(toolIconName("grep")).toBe("filter");
    expect(toolIconName("glob")).toBe("filter");
    expect(toolIconName("ripgrep")).toBe("filter");
  });

  it("maps list/ls/dir tools to 'menu'", () => {
    expect(toolIconName("list")).toBe("menu");
    expect(toolIconName("ls")).toBe("menu");
  });

  it("maps fetch/curl/wget/web tools to 'send'", () => {
    expect(toolIconName("fetch")).toBe("send");
    expect(toolIconName("webfetch")).toBe("send");
    expect(toolIconName("curl")).toBe("send");
  });

  it("maps task/agent tools to 'fork'", () => {
    expect(toolIconName("task")).toBe("fork");
    expect(toolIconName("agent")).toBe("fork");
  });

  it("maps a bare todo tool to 'check'", () => {
    // A name that is ONLY "todo" (no write/list/edit keyword) reaches the todo
    // branch. "todowrite" does NOT — see the ordering-collisions test below.
    expect(toolIconName("todo")).toBe("check");
  });

  it("maps a question tool to 'help'", () => {
    expect(toolIconName("question")).toBe("help");
  });

  it("maps a skill tool to 'info'", () => {
    expect(toolIconName("skill")).toBe("info");
  });

  it("does NOT map 'lsp' to info — the earlier 'ls' substring wins 'menu'", () => {
    // Characterization quirk: "lsp" contains "ls", which the list|ls|dir branch
    // (checked earlier) catches before the lsp|skill branch is ever reached. Pin
    // this so a future branch reorder surfaces as a visible diff.
    expect(toolIconName("lsp")).toBe("menu");
  });

  it("matches case-insensitively", () => {
    expect(toolIconName("BASH")).toBe("terminal");
    expect(toolIconName("Write")).toBe("edit");
    expect(toolIconName("WebFetch")).toBe("send");
  });

  it("returns 'layers' (the default) for an unrecognized tool", () => {
    expect(toolIconName("some_unknown_tool")).toBe("layers");
  });

  it("returns 'layers' (the default) for an empty string", () => {
    expect(toolIconName("")).toBe("layers");
  });

  it("resolves ordering collisions by the first matching branch", () => {
    // "str_replace_editor" matches BOTH the edit/write branch (str_replace, edit)
    // and would match nothing later — confirms the edit branch wins early.
    expect(toolIconName("str_replace_editor")).toBe("edit");
    // A name containing both a write and a todo keyword takes edit (earlier
    // branch), NOT check — pins the branch ordering.
    expect(toolIconName("todo_writer")).toBe("edit");
  });
});
