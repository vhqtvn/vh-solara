// Pure text-extraction helpers for the per-message Copy button (ChatView.tsx)
// and the Retry action. Kept in a leaf module with no store/component imports so
// unit tests can import them without pulling in the Solid runtime — same
// leaf-module rationale as toolLabel.ts.
//
// The Copy button is split:
//   - left-click  -> msgTextOnly          (text parts only, NO thinking)
//   - right-click -> msgTextWithThinking  (text parts + reasoning, each
//                                          contiguous reasoning run wrapped in
//                                          a single <think>…</think>)
// Retry reuses msgTextOnly: retry re-sends as a user prompt, so thinking must
// never be included. For a message with no reasoning parts, msgTextOnly is
// byte-identical to the old text+reasoning join, so Retry is unchanged.

// The slice of a message we read. Mirrors the shape ChatView's old msgText took,
// decoupled from the full MessageView type so this leaf stays independent.
interface MessageLike {
  partOrder: string[];
  // Parts arrive raw from the aggregator with arbitrary extra fields, so index
  // loosely (same `any` typing the old msgText used).
  parts: Record<string, any>;
}

// Concatenate ONLY the message's text parts (NO reasoning/thinking), in
// partOrder, joined with "\n". For a message with no reasoning parts the output
// is byte-identical to the legacy text+reasoning join — this is what Retry and
// left-click Copy use.
export function msgTextOnly(m: MessageLike): string {
  return (m.partOrder || [])
    .map((pid) => m.parts?.[pid])
    .filter((p) => p && p.type === "text")
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

// Concatenate text AND reasoning parts, preserving partOrder, with each
// CONTIGUOUS run of reasoning parts wrapped in a single <think>…</think>. Text
// parts stay unwrapped. A lone reasoning part gets its own wrapper; a run of
// consecutive reasoning parts share one wrapper around the "\n"-joined text.
// Any non-text/non-reasoning part (e.g. a tool-use part) breaks a reasoning run
// and is itself dropped (it carries no copyable text).
export function msgTextWithThinking(m: MessageLike): string {
  const out: string[] = [];
  let thinkBuf: string[] = [];
  const flush = () => {
    if (thinkBuf.length) {
      out.push(`<think>${thinkBuf.join("\n")}</think>`);
      thinkBuf = [];
    }
  };
  for (const pid of m.partOrder || []) {
    const p = m.parts?.[pid];
    if (!p) continue;
    if (p.type === "reasoning") {
      thinkBuf.push(p.text || "");
    } else {
      flush();
      if (p.type === "text") out.push(p.text || "");
    }
  }
  flush();
  return out.join("\n").trim();
}
