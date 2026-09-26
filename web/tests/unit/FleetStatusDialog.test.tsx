// @vitest-environment jsdom
//
// Lane-5 coverage for the fleet-status config pane (slice C2,
// FleetStatusDialog — reached from AdminMenu → "Fleet status"):
//   • writable GET renders editable rows; add-worker + Save issues PUT
//     /vh/fleet/config with the exact file-schema body and the CSRF header,
//     then re-GETs (persisted state reflected, "✓ Saved").
//   • PUT 409 flips the pane to the read-only posture: the off-hint
//     (--status-config) renders and Save disables.
//   • PUT 400 surfaces the server's precise validation message verbatim.
//   • duplicate project dir (exact verbatim equality) gets immediate client
//     feedback and disables Save without issuing a PUT.
//   • remove-row flow PUTs the roster without the removed entry.
//   • GET writable:false renders read-only rows + hint, no inputs, Save off.
//   • non-JSON body hardening: a 200 HTML body (misrouted proxy / worker SPA
//     fallback) becomes a clean not-JSON load error — never a raw JSON.parse
//     exception message; an error status still reports the HTTP code.
//   • AdminMenu wiring: the "Fleet status" entry opens the dialog while the
//     menu stays mounted.
//
// Client validation mirrors pkg/server/status_config.go but the SERVER is the
// authority — the 400 test pins that the server's message wins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import FleetStatusDialog from "../../src/components/FleetStatusDialog";
import AdminMenu from "../../src/components/AdminMenu";

const CFG_WRITABLE = {
  schema: 1,
  writable: true,
  workers: [{ id: "build-box", label: "Primary builder" }],
  projects: [{ dir: "/srv/repos/service", label: "Prod" }],
};
const CFG_EMPTY_WRITABLE = { schema: 1, writable: true, workers: [], projects: [] };
const CFG_READONLY = {
  schema: 1,
  writable: false,
  workers: [{ id: "build-box", label: "Primary builder" }],
  projects: [],
};

function respJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}
// Server refusals (409/400) use http.Error → plain-text bodies.
function respText(text: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => ({}),
  } as unknown as Response;
}

interface Call {
  url: string;
  init?: RequestInit;
}

// Router-style fetch stub: GET /vh/fleet/config serves `get`; PUT serves
// `put`. Every call is recorded for method/header/body assertions.
function stubFleet(get: unknown, put?: { status: number; text?: string; body?: unknown }) {
  const calls: Call[] = [];
  const mock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url.includes("/vh/fleet/config") && method === "PUT" && put) {
      return put.body !== undefined
        ? Promise.resolve(respJson(put.body, put.status >= 200 && put.status < 300, put.status))
        : Promise.resolve(respText(put.text ?? "", put.status));
    }
    if (url.includes("/vh/fleet/config")) {
      return Promise.resolve(respJson(get));
    }
    return Promise.resolve(respJson({}));
  });
  vi.stubGlobal("fetch", mock);
  const fleetCalls = () =>
    calls.filter((c) => c.url.includes("/vh/fleet/config"));
  const puts = () => fleetCalls().filter((c) => c.init?.method === "PUT");
  const gets = () => fleetCalls().filter((c) => (c.init?.method ?? "GET") === "GET");
  return { calls, puts, gets };
}

function btn(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === label,
  ) as HTMLButtonElement | undefined;
}
function btnIncluding(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(text),
  ) as HTMLButtonElement | undefined;
}

// Solid inputs listen for the input event; set .value then dispatch.
function setInput(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(el, `expected input[aria-label="${label}"]`).toBeTruthy();
  return el!;
}

describe("FleetStatusDialog — edit + save (writable)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("add-worker + Save PUTs the file-schema body with the CSRF header, then re-GETs", async () => {
    const { puts, gets } = stubFleet(CFG_WRITABLE, {
      status: 200,
      body: CFG_WRITABLE,
    });
    render(() => <FleetStatusDialog onClose={() => {}} />);

    // Rows seeded from GET: the existing worker id + project dir render.
    await waitFor(() => expect(inputByLabel("Worker 1 id").value).toBe("build-box"));
    expect(inputByLabel("Project 1 dir").value).toBe("/srv/repos/service");
    expect(gets().length).toBe(1);

    // Add a worker row and fill its id (label stays empty → omitted on wire).
    btn("Add worker")!.click();
    await waitFor(() => expect(inputByLabel("Worker 2 id")).toBeTruthy());
    setInput(inputByLabel("Worker 2 id"), "gpu-box");

    btn("Save")!.click();
    await waitFor(() => expect(puts().length).toBe(1));

    // PUT: exact URL, method, CSRF + JSON headers, and the exact body —
    // file schema only ({workers, projects}), empty labels omitted, no
    // schema/writable keys (the server's strict decode would reject them).
    const put = puts()[0];
    expect(put.url).toBe("/vh/fleet/config");
    expect(put.init!.method).toBe("PUT");
    const headers = put.init!.headers as Record<string, string>;
    expect(headers["X-VH-CSRF"]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(put.init!.body as string)).toEqual({
      workers: [
        { id: "build-box", label: "Primary builder" },
        { id: "gpu-box" },
      ],
      projects: [{ dir: "/srv/repos/service", label: "Prod" }],
    });

    // Success → re-GET (reflect the persisted state) + the Saved note.
    await waitFor(() => expect(gets().length).toBe(2));
    await waitFor(() => expect(document.body.textContent).toContain("✓ Saved"));
  });

  it("PUT 409 renders the off-hint, disables Save, and flips to read-only rows", async () => {
    stubFleet(CFG_WRITABLE, {
      status: 409,
      text: "fleet status config is read-only: no --status-config path is configured on this controller",
    });
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => expect(inputByLabel("Worker 1 id").value).toBe("build-box"));
    btn("Save")!.click();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Config management is off");
      expect(document.body.textContent).toContain("--status-config");
    });
    // Save disabled + rows are read-only (id still visible as text, no inputs).
    await waitFor(() => expect(btn("Save")!.disabled).toBe(true));
    expect(document.querySelector('input[aria-label="Worker 1 id"]')).toBeNull();
    expect(document.body.textContent).toContain("build-box");
    expect(document.body.textContent).toContain("Primary builder");
  });

  it("PUT 400 surfaces the server's validation message verbatim", async () => {
    const msg =
      'invalid fleet config: workers[0].id: invalid worker id "bad id" (must be non-empty ASCII letters/digits/\'.\'/_/\'-\' — the id is substituted into configured host patterns)';
    stubFleet(CFG_WRITABLE, { status: 400, text: msg });
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => expect(inputByLabel("Worker 1 id").value).toBe("build-box"));
    btn("Save")!.click();

    // The server's precise message, verbatim — no client-side guessing.
    await waitFor(() => expect(document.body.textContent).toContain(msg));
    // The refusal did NOT flip the pane read-only (that is the 409 posture).
    expect(inputByLabel("Worker 1 id").value).toBe("build-box");
    await waitFor(() => expect(btn("Save")!.disabled).toBe(false));
  });

  it("remove-row flow: removing a worker PUTs the roster without it", async () => {
    const { puts } = stubFleet(CFG_WRITABLE, { status: 200, body: CFG_WRITABLE });
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => expect(inputByLabel("Worker 1 id").value).toBe("build-box"));
    document.querySelector('button[aria-label="Remove worker 1"]')!.click();
    await waitFor(() => expect(document.querySelector('input[aria-label="Worker 1 id"]')).toBeNull());

    btn("Save")!.click();
    await waitFor(() => expect(puts().length).toBe(1));
    expect(JSON.parse(puts()[0].init!.body as string)).toEqual({
      workers: [],
      projects: [{ dir: "/srv/repos/service", label: "Prod" }],
    });
  });
});

describe("FleetStatusDialog — client validation mirrors the server (UX sugar)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("duplicate project dir (verbatim) flags the later row and disables Save without a PUT", async () => {
    const { puts } = stubFleet(CFG_EMPTY_WRITABLE);
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add project")).toBeTruthy());
    btn("Add project")!.click();
    btn("Add project")!.click();
    await waitFor(() => expect(inputByLabel("Project 1 dir")).toBeTruthy());
    setInput(inputByLabel("Project 1 dir"), "/srv/same");
    setInput(inputByLabel("Project 2 dir"), "/srv/same");

    // Immediate per-row feedback on the LATER occurrence (server semantics).
    await waitFor(() =>
      expect(document.body.textContent).toContain('duplicate project dir "/srv/same"'),
    );
    expect(btn("Save")!.disabled).toBe(true);
    // No PUT issued — the client mirror blocked the round-trip.
    expect(puts().length).toBe(0);
  });

  it("invalid worker id charset gets immediate row feedback", async () => {
    stubFleet(CFG_EMPTY_WRITABLE);
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add worker")).toBeTruthy());
    btn("Add worker")!.click();
    await waitFor(() => expect(inputByLabel("Worker 1 id")).toBeTruthy());
    setInput(inputByLabel("Worker 1 id"), "bad id!");

    await waitFor(() =>
      expect(document.body.textContent).toContain("invalid worker id"),
    );
    expect(btn("Save")!.disabled).toBe(true);
  });
});

describe("FleetStatusDialog — read-only posture (writable:false)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders read-only rows + the off-hint; Save disabled; no add buttons or inputs", async () => {
    stubFleet(CFG_READONLY);
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Config management is off");
      expect(document.body.textContent).toContain("--status-config");
    });
    // Rows render as text (id + label), never inputs.
    await waitFor(() => expect(document.body.textContent).toContain("build-box"));
    expect(document.body.textContent).toContain("Primary builder");
    expect(document.querySelectorAll("input").length).toBe(0);
    expect(btn("Add worker")).toBeUndefined();
    expect(btn("Add project")).toBeUndefined();
    expect(btn("Save")!.disabled).toBe(true);
  });

  it("an empty read-only config says so explicitly", async () => {
    stubFleet({ schema: 1, writable: false, workers: [], projects: [] });
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("No workers configured");
      expect(document.body.textContent).toContain("No projects configured");
    });
  });
});

describe("FleetStatusDialog — non-JSON response hardening", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a 200 HTML body (misrouted proxy / worker SPA fallback) surfaces a clean not-JSON error, not a raw parse exception", async () => {
    // The operator regression this guards: with the SPA served from a worker
    // subdomain, /vh/fleet/config was proxied to the worker, whose catch-all
    // answers unknown /vh/* paths with the SPA shell — 200, text/html,
    // unparseable. The pane must say so honestly instead of leaking the
    // browser's raw "JSON.parse: unexpected character …" exception message.
    const html = "<!DOCTYPE html><html><body>spa shell</body></html>";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respText(html, 200))));
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't load the fleet config (Unexpected response from server (not JSON; HTTP 200)).",
      ),
    );
    // The raw parser message must NOT leak into the UI.
    expect(document.body.textContent).not.toContain("JSON.parse");
    // The error posture offers Retry and renders no rows/inputs.
    expect(btn("Retry")).toBeTruthy();
    expect(document.querySelectorAll("input").length).toBe(0);
  });

  it("a non-JSON body on an error status still reports the HTTP code (no behavior change)", async () => {
    // !ok short-circuits before any body parse — a plain-text 404 (e.g. a
    // dead proxy) keeps the existing "HTTP <status>" error.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(respText("not found", 404))));
    render(() => <FleetStatusDialog onClose={() => {}} />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't load the fleet config (HTTP 404)."),
    );
  });
});

describe("AdminMenu — Fleet status entry wiring", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the 'Fleet status' entry opens the dialog while the menu stays mounted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/version")) return Promise.resolve(respJson({ version: "v1" }));
        if (url.includes("/vh/opencode-version")) {
          return Promise.resolve(
            respJson({
              installed: "0.2.0",
              running: "0.2.0",
              latest: "0.2.0",
              updateAvailable: false,
              restartNeeded: false,
            }),
          );
        }
        if (url.includes("/vh/fleet/config")) return Promise.resolve(respJson(CFG_EMPTY_WRITABLE));
        return Promise.resolve(respJson({}));
      }),
    );
    render(() => <AdminMenu onClose={() => {}} />);

    const entry = await waitFor(() => {
      const b = btn("Fleet status");
      expect(b).toBeTruthy();
      return b!;
    });
    expect(entry.classList.contains("admin-btn")).toBe(true);

    entry.click();
    await waitFor(() =>
      expect(document.querySelector('.dialog[aria-label="Fleet status"]')).toBeTruthy(),
    );
    // The admin menu itself is still mounted behind the portaled dialog.
    expect(document.querySelector(".admin-menu")).toBeTruthy();
    // The dialog loaded the config (sections render).
    await waitFor(() => expect(document.body.textContent).toContain("Workers"));
  });
});
