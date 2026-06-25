// Cross-component state for the code view, kept in a module (not the component)
// so the open file survives switching tabs, and so the chat (a tool's file, a
// path:line reference) and search results can open a file at a line.
import { createSignal } from "solid-js";
import { setView } from "./ui";

// The file currently open in the code view (rel to the project dir), and an
// optional line to scroll to / highlight.
export const [codeOpenPath, setCodeOpenPath] = createSignal("");
export const [codeOpenLine, setCodeOpenLine] = createSignal<number | undefined>(undefined);

// Open a file in the code view, optionally at a line. Accepts a raw reference
// like "src/parser.go:42" (strips a leading "./" and a trailing :line[:col]).
export function openFileAt(pathOrRef: string, line?: number) {
  let path = pathOrRef.trim().replace(/^\.\//, "");
  if (line === undefined) {
    const m = path.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (m) {
      path = m[1];
      line = Number(m[2]);
    }
  }
  setCodeOpenLine(line);
  setCodeOpenPath(path);
  setView("code");
}
