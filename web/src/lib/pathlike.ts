// Cheap, regex-only test for "does this text look like a file path?" — used to
// decide whether to OFFER opening it (ctrl-click inline code, a text selection).
// Actual resolution (which touches the filesystem) only runs once the user acts,
// so this stays deliberately loose and fast; false positives just fail to resolve.
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 240 || /\s/.test(t)) return false;
  const core = t.replace(/:\d+(?::\d+)?$/, ""); // drop a trailing :line[:col]
  if (!/^[\w.@~\-/]+$/.test(core)) return false; // path-ish chars only (rejects URLs — they have ":")
  if (core.includes("/")) return true; // has a path separator
  return /\.[A-Za-z][\w]{0,9}$/.test(core); // else a bare filename with an extension
}
