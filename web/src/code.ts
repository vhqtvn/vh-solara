// State for the code viewer, used INSIDE the code frame (the standalone page
// rendered in an iframe). The open file/line live here; the chat (in the parent
// frame) drives them across the frame boundary via postMessage — see codeFrame.ts.
import { createSignal } from "solid-js";

export const [codeOpenPath, setCodeOpenPath] = createSignal("");
export const [codeOpenLine, setCodeOpenLine] = createSignal<number | undefined>(undefined);

// Open a file in the (in-frame) viewer, optionally at a line. Accepts a raw
// reference like "src/parser.go:42" (strips a leading "./" and a trailing
// :line[:col]). Called by the frame's own UI and by its postMessage handler.
export function openFileLocal(pathOrRef: string, line?: number) {
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
}
