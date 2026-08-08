// Shared fixtures for the config-driven fleet proof
// (tests/fleet-e2e + playwright.fleet.config.ts). The config uses FLEET_JSON to
// seed VITE_SERVERS on the dedicated host dev server; the spec uses FLEET_SERVERS
// to assert the seeded panes carry EXACTLY these {url,label} pairs (and NOT the
// mock fleet). Keeping them in one module guarantees the two sides never drift.
//
// The urls intentionally point at the EXISTING mock content page (:5174) with
// distinct ?server=&view= params, so the panes load real iframe content and
// heartbeat normally WITHOUT needing a live real vh-solara server. This proves
// resolveFleet() drives real-fleet seeding while reusing the mock content page
// as a stand-in "real" server.

export interface FleetEntry {
  url: string;
  label: string;
}

export const FLEET_SERVERS: FleetEntry[] = [
  { url: "http://127.0.0.1:5174/?server=fleet-a&view=chat", label: "fleet-a" },
  { url: "http://127.0.0.1:5174/?server=fleet-B&view=chat", label: "fleet-B" },
];

// NEGATIVE fixture: a `javascript:` entry that isFleetEntry() MUST reject (the
// F1 guard). It is included in FLEET_JSON (baked into VITE_SERVERS) ALONGSIDE
// the valid http entries, so the fleet spec can assert resolveFleet() filters
// it out and it never reaches an unsandboxed iframe.src. A `javascript:` value
// in iframe.src would execute same-origin against the host shell — this entry
// proves the guard closes that path (proven, not just a code-read claim).
//
// The payload body is intentionally quote-free: FLEET_JSON is interpolated into
// the shell command `VITE_SERVERS='...'` in playwright.fleet.config.ts, and a
// single quote would prematurely terminate that single-quoted string. What
// matters for the guard test is the `javascript:` SCHEME being rejected (the
// guard rejects it before it could ever execute), so the body need not be a
// maximally-scary XSS — `alert(document.domain)` is enough.
export const FLEET_POISONED: FleetEntry = {
  url: "javascript:alert(document.domain)",
  label: "evil",
};

// The raw VITE_SERVERS input: the valid entries AND the poisoned one. Seeding
// must keep ONLY the valid entries (FLEET_SERVERS); the poison is filtered out.
const FLEET_INPUT: FleetEntry[] = [...FLEET_SERVERS, FLEET_POISONED];

/** VITE_SERVERS value (JSON array string) consumed by resolveFleet(). */
export const FLEET_JSON: string = JSON.stringify(FLEET_INPUT);

/** Base URL of the dedicated host dev server started with VITE_SERVERS set. */
export const FLEET_HOST_BASE = "http://127.0.0.1:5177";
