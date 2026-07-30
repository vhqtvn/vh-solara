// Sidebar UI state: the session-search query.
//
// The pin-authority cluster (pin membership + order, the PUT /vh/pins CAS
// facade, the legacy localStorage fallback, and the pins.snapshot /
// pins.updated stream entries) has fully migrated to ./pins.ts. This module
// now keeps ONLY the in-memory search-query signal (zero coupling to the pin
// CAS). All pin APIs must be imported from ./pins directly — this module no
// longer re-exports them.
import { createSignal } from "solid-js";

const [searchQuery, setSearchQuery] = createSignal("");
export { searchQuery, setSearchQuery };
