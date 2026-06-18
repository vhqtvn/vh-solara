// Sent-prompt history for up/down recall in the composer (shell-style). Global
// across sessions, persisted, de-duplicated, most-recent first, capped.
import { loadVersioned, saveVersioned } from "./lib/store";

const KEY = "vh.prompt.history.v1";
const MAX = 100;

let hist: string[] = loadVersioned<string[]>(KEY, 1, [], (o) => (Array.isArray(o) ? (o as string[]) : []));

export function pushHistory(text: string) {
  const t = text.trim();
  if (!t) return;
  hist = [t, ...hist.filter((x) => x !== t)].slice(0, MAX);
  saveVersioned(KEY, 1, hist);
}

// 0 = most recent. Returns undefined past the ends.
export function historyAt(index: number): string | undefined {
  return index >= 0 && index < hist.length ? hist[index] : undefined;
}
export function historyLen(): number {
  return hist.length;
}
