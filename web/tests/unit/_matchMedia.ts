// Shared jsdom stub for window.matchMedia (test-infra helper, not a spec).
//
// Importing the SolidJS component graph in unit tests pulls through
// code/frame -> layout.ts, which reads window.matchMedia at MODULE-LOAD time.
// jsdom does not implement matchMedia, so it must be installed BEFORE any
// component import is evaluated.
//
// ESM hoists static imports above top-level statements, so a plain
// `installMatchMediaStub()` call placed after the import line would run too
// late — which is exactly why the consuming test files previously wrapped the
// stub in `vi.hoisted(() => { ... })`. Centralizing the stub here removes that
// duplication: this module installs it as a SIDE EFFECT of being imported, so
// a bare `import "./_matchMedia"` placed BEFORE any component import is
// sufficient (the helper module body runs in source order, ahead of the
// component module graph), and no `vi.hoisted` is needed at the call site.
//
// Idempotent: importing it from many files and/or calling the export
// explicitly is always safe (it no-ops when a matchMedia already exists).
//
// NOT a migration target for files that test matchMedia BEHAVIOR rather than
// just module-load survival: a11y.test.ts (smart pointer:coarse variant),
// pwa-diagnostics.test.ts, and Select.test.tsx keep their own bespoke stubs.

/** Minimal MediaQueryList-like mock: `matches: false` for every query. */
export interface MatchMediaMock {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: () => void;
  removeEventListener: () => void;
  addListener: () => void;
  removeListener: () => void;
  dispatchEvent: () => boolean;
}

/**
 * Install a minimal `window.matchMedia` stub if one is not already present.
 * Idempotent — safe to call repeatedly and to import from many test files.
 */
export function installMatchMediaStub(): void {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (w.matchMedia) return;
  w.matchMedia = (query: string): MatchMediaMock => ({
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

// Install on import so `import "./_matchMedia"` (placed before component
// imports) survives layout.ts's module-load matchMedia read.
installMatchMediaStub();
