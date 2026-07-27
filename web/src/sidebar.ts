// Sidebar UI state: the session-search query.
//
// The pin-authority cluster (pin membership + order, the PUT /vh/pins CAS
// facade, the legacy localStorage fallback, and the pins.snapshot /
// pins.updated stream entries) has moved to ./pins.ts. This module keeps the
// in-memory search-query signal (zero coupling to the pin CAS) and re-exports
// the full pin API so existing importers (sync/stream.ts, the sidebar
// components) keep resolving. New code should import pin APIs from ./pins
// directly; the re-export here is a back-compat shim that may be removed once
// all consumers migrate.
import { createSignal } from "solid-js";

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };

// Back-compat re-export of the pin-authority cluster. See ./pins.ts.
export type { PinDoc, PinErrorKind } from "./pins";
export {
  coercePinDoc,
  pinned,
  isPinned,
  reconciledPinnedOrder,
  pinsRevision,
  pinsInitialized,
  pinsServerMode,
  pinsPending,
  pinsLastError,
  clearPinsError,
  applyPinsSnapshot,
  applyPinsUpdated,
  dropPinnedSession,
  togglePin,
  movePinnedTo,
  movePinnedByOffset,
  __resetPinnedForTest,
} from "./pins";
