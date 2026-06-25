// Client side of the render pipeline: requests HTML for settled content from
// the daemon (POST /vh/render), batching calls within a frame and caching
// results by content so each unique block is rendered once. In-flight streaming
// content is rendered raw by the caller, not here.

type Kind = "markdown" | "diff" | "patch";

interface PendingReq {
  key: string;
  body: Record<string, string>;
  resolve: (html: string) => void;
}

// Bounded cache (insertion-ordered FIFO eviction) so a long-lived session that
// renders thousands of distinct parts can't grow browser memory without bound.
const cache = new Map<string, string>();
const CACHE_MAX = 1000;
function cacheSet(key: string, html: string) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
}
let queue: PendingReq[] = [];
let scheduled = false;

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(flush, 16);
}

async function flush() {
  scheduled = false;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;

  const reqs = batch.map((b, i) => ({ id: String(i), ...b.body }));
  try {
    const res = await fetch("/vh/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqs),
    });
    const arr: { id: string; html: string }[] = await res.json();
    const byId = new Map(arr.map((r) => [r.id, r.html]));
    batch.forEach((b, i) => {
      const html = byId.get(String(i)) ?? "";
      cacheSet(b.key, html);
      b.resolve(html);
    });
  } catch {
    // On failure resolve with empty; caller keeps showing the raw fallback.
    batch.forEach((b) => b.resolve(""));
  }
}

function enqueue(kind: Kind, key: string, body: Record<string, string>): Promise<string> {
  const cacheKey = kind + "" + key;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve) => {
    queue.push({ key: cacheKey, body: { kind, ...body }, resolve });
    schedule();
  });
}

export function renderMarkdown(text: string): Promise<string> {
  return enqueue("markdown", text, { text });
}

export function renderPatch(patch: string, mode: "unified" | "split" = "unified"): Promise<string> {
  // Key by mode so unified and split are cached independently.
  return enqueue("patch", mode + "" + patch, mode === "split" ? { patch, mode } : { patch });
}
