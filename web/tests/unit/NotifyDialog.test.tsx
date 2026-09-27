// @vitest-environment jsdom
//
// Lane-5 coverage for the push-notification admin pane (slice S3,
// NotifyDialog — reached from AdminMenu → "Push notifications"):
//   • masked device list render (label/preview/date/scope badge/telemetry);
//   • add-device: POST /vh/notify/tokens with the exact body + CSRF
//     header, then re-GET; client token validation mirrors the server
//     (byte bounds / printable ASCII) without a round-trip; the
//     server's 400 lands verbatim;
//   • enable/disable toggle: PATCH wholesale scope body (BOTH members);
//   • scope editor: nine condition checkboxes + select-all; Save PATCHes
//     the wholesale scope (canonical order, all-nine → []); an EMPTY
//     selection requires the explicit confirm whose text states the
//     wire truth ([] = ALL nine kinds);
//   • delete: confirm step naming unrecoverability/re-enrollment, then
//     DELETE with CSRF;
//   • test send: per-row {id} and raw-token {token} paths; {sent,
//     transport} surfaced inline; error verbatim; 429 wait hint
//     (body + Retry-After);
//   • 409 (--notify-store off): whole dialog read-only + off-hint;
//   • history: newest-first render with color-coded action chips,
//     relative ts, expandable per-token deliveries; empty state
//     ("no notifications yet") distinguished from the 409 posture;
//   • AdminMenu wiring: the "Push notifications" entry opens the dialog
//     while the menu stays mounted.
//
// Wire mirrors pkg/server/notify_http.go + notify_history.go; the server
// is the authority — the 400 test pins that its message wins verbatim.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import NotifyDialog from "../../src/components/NotifyDialog";
import AdminMenu from "../../src/components/AdminMenu";
import styles from "../../src/components/NotifyDialog.module.css";

const TOK1 = {
  id: "0011223344556677",
  label: "Operator phone",
  token_preview: "fcm-to…1234",
  created_at: "2026-09-20T10:00:00Z",
  last_used_at: "2026-09-27T09:00:00Z",
  last_error: "",
  scope: { enabled: true, conditions: [] },
};
const TOK2 = {
  id: "8899aabbccddeeff",
  label: "",
  token_preview: "fcm-tw…5678",
  created_at: "2026-09-21T10:00:00Z",
  last_used_at: null,
  last_error: "send failed: HTTP 404",
  scope: { enabled: false, conditions: ["worker_down", "session_error", "session_unread"] },
};

const NOW = Date.now();
const HIST = {
  schema: 1,
  events: [
    {
      id: 1,
      ts: new Date(NOW - 3600_000).toISOString(),
      kind: "worker_down",
      action: "appeared",
      count: 2,
      title: "vh-solara",
      body: "2 workers down",
      deliveries: [{ token_id: "0011223344556677", ok: true }],
    },
    {
      id: 2,
      ts: new Date(NOW - 60_000).toISOString(),
      kind: "session_error",
      action: "cleared",
      count: 0,
      title: "vh-solara",
      body: "session errors (cleared)",
      deliveries: [
        { token_id: "0011223344556677", ok: false, error: "HTTP 500: backend error" },
        { token_id: "8899aabbccddeeff", ok: false, retired: true },
      ],
    },
    {
      id: 3,
      ts: new Date(NOW - 1800_000).toISOString(),
      kind: "question_pending",
      action: "changed",
      count: 5,
      title: "vh-solara",
      body: "5 questions pending",
      deliveries: [{ token_id: "0011223344556677", ok: true }],
    },
  ],
  first_id: 1,
  last_id: 3,
};

function respJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}
// Server refusals (409/400/429) use http.Error → plain-text bodies; the
// 429 additionally carries Retry-After.
function respText(text: string, status: number, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => ({}),
    headers: {
      get: (n: string) => headers?.[n] ?? null,
    },
  } as unknown as Response;
}

interface Call {
  url: string;
  init?: RequestInit;
}

type Endpoint = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

// Router-style fetch stub for the /vh/notify/* family. Unspecified
// endpoints answer their empty 200 default; every call is recorded for
// method/header/body assertions.
function stubNotify(cfg: {
  getTokens?: Endpoint;
  create?: Endpoint;
  patch?: Endpoint;
  del?: Endpoint;
  test?: Endpoint;
  history?: Endpoint;
}) {
  const calls: Call[] = [];
  const mock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    const answer = (e: Endpoint | undefined, fallback: unknown): Response =>
      e === undefined
        ? respJson(fallback)
        : e.body !== undefined
          ? respJson(e.body, e.status >= 200 && e.status < 300, e.status)
          : respText(e.text ?? "", e.status, e.headers);
    if (url.includes("/vh/notify/test") && method === "POST") {
      return Promise.resolve(answer(cfg.test, { schema: 1, sent: true, transport: "fcm" }));
    }
    if (url.includes("/vh/notify/tokens") && method === "POST") {
      return Promise.resolve(
        answer(cfg.create, { schema: 1, created: true, token: TOK1 }),
      );
    }
    if (url.includes("/vh/notify/tokens") && method === "PATCH") {
      return Promise.resolve(answer(cfg.patch, { schema: 1, token: TOK1 }));
    }
    if (url.includes("/vh/notify/tokens") && method === "DELETE") {
      return Promise.resolve(answer(cfg.del, { schema: 1 }));
    }
    if (url.includes("/vh/notify/tokens") && method === "GET") {
      return Promise.resolve(answer(cfg.getTokens, { schema: 1, tokens: [] }));
    }
    if (url.includes("/vh/notify/history")) {
      return Promise.resolve(answer(cfg.history, { schema: 1, events: [], first_id: 0, last_id: 0 }));
    }
    return Promise.resolve(respJson({}));
  });
  vi.stubGlobal("fetch", mock);
  const of = (method: string, frag: string) =>
    calls.filter((c) => (c.init?.method ?? "GET") === method && c.url.includes(frag));
  return {
    calls,
    posts: () => of("POST", "/vh/notify/tokens"),
    patches: () => of("PATCH", "/vh/notify/tokens"),
    deletes: () => of("DELETE", "/vh/notify/tokens"),
    tests: () => of("POST", "/vh/notify/test"),
    tokenGets: () => of("GET", "/vh/notify/tokens"),
    histGets: () => of("GET", "/vh/notify/history"),
  };
}

function btn(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === label,
  ) as HTMLButtonElement | undefined;
}
function btnByLabel(label: string): HTMLButtonElement {
  const el = document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  expect(el, `expected button[aria-label="${label}"]`).toBeTruthy();
  return el!;
}

// Solid inputs listen for the input event; set .value then dispatch.
function setInput(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
// Solid checkboxes: set .checked then dispatch change.
function setCheckbox(el: HTMLInputElement, value: boolean) {
  el.checked = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function inputByLabel(label: string): HTMLInputElement {
  const el = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(el, `expected input[aria-label="${label}"]`).toBeTruthy();
  return el!;
}

describe("NotifyDialog — devices list (masked render)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders masked rows: label/preview/date/scope badge + telemetry lines", async () => {
    stubNotify({ getTokens: { status: 200, body: { schema: 1, tokens: [TOK1, TOK2] } } });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    // Masked previews (mono), never raw tokens — the wire only carries these.
    expect(document.body.textContent).toContain("fcm-to…1234");
    expect(document.body.textContent).toContain("fcm-tw…5678");
    // Unlabeled hint + short created_at.
    expect(document.body.textContent).toContain("Unlabeled device");
    expect(document.body.textContent).toContain("2026-09-20");
    // Scope badges: enabled + all-events vs disabled + subset summary.
    expect(document.body.textContent).toContain("on · all events");
    expect(document.body.textContent).toContain("off · 3 of 9 events");
    // Telemetry: used date on TOK1, never-used + verbatim last_error on TOK2.
    expect(document.body.textContent).toContain("used 2026-09-27");
    expect(document.body.textContent).toContain("never used");
    expect(document.body.textContent).toContain("last error: send failed: HTTP 404");
    // Empty history state (distinct from the 409 posture, below).
    expect(document.body.textContent).toContain("No notifications yet");
  });
});

describe("NotifyDialog — add device (POST + CSRF + client mirror)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Add device POSTs the exact body with the CSRF header, then re-GETs", async () => {
    const { posts, tokenGets } = stubNotify({});
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add device")).toBeTruthy());
    setInput(inputByLabel("New device token"), "fcm-newdevice-000001");
    setInput(inputByLabel("New device label"), "Tablet");

    btn("Add device")!.click();
    await waitFor(() => expect(posts().length).toBe(1));

    const post = posts()[0];
    expect(post.url).toBe("/vh/notify/tokens");
    const headers = post.init!.headers as Record<string, string>;
    expect(headers["X-VH-CSRF"]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.init!.body as string)).toEqual({
      token: "fcm-newdevice-000001",
      label: "Tablet",
    });
    // Success note + the list is re-fetched.
    await waitFor(() => expect(document.body.textContent).toContain("✓ Device added"));
    await waitFor(() => expect(tokenGets().length).toBe(2));
  });

  it("client validation mirrors the server: too-short token blocks the POST; the server's 400 wins verbatim", async () => {
    const { posts } = stubNotify({});
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add device")).toBeTruthy());
    setInput(inputByLabel("New device token"), "short");
    btn("Add device")!.click();

    await waitFor(() =>
      expect(document.body.textContent).toContain("outside the 16..2048 byte bounds"),
    );
    expect(posts().length).toBe(0); // blocked client-side, no round-trip

    // Non-printable-ASCII (a space) is caught by the mirror too.
    setInput(inputByLabel("New device token"), "has space-00000001");
    btn("Add device")!.click();
    await waitFor(() => expect(document.body.textContent).toContain("not printable ASCII"));
    expect(posts().length).toBe(0);
  });
});

describe("NotifyDialog — enable/disable toggle (wholesale PATCH)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Disable PATCHes scope wholesale: both members, conditions carried as stored", async () => {
    const { patches } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 disable").click();
    await waitFor(() => expect(patches().length).toBe(1));

    const patch = patches()[0];
    expect(patch.url).toBe(`/vh/notify/tokens/${TOK1.id}`);
    const headers = patch.init!.headers as Record<string, string>;
    expect(headers["X-VH-CSRF"]).toBe("1");
    expect(JSON.parse(patch.init!.body as string)).toEqual({
      scope: { enabled: false, conditions: [] },
    });
  });

  it("Enable on a subset-scoped device carries the explicit conditions list", async () => {
    const { patches } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK2] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Unlabeled device"));
    btnByLabel("Device 1 enable").click();
    await waitFor(() => expect(patches().length).toBe(1));
    expect(JSON.parse(patches()[0].init!.body as string)).toEqual({
      scope: { enabled: true, conditions: ["worker_down", "session_error", "session_unread"] },
    });
  });
});

describe("NotifyDialog — scope editor (nine checkboxes, wholesale body, empty confirm)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opening the editor seeds all-nine for an empty (all) scope; unchecking one PATCHes the canonical subset", async () => {
    const { patches } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 scope").click();

    // The editor renders the enabled checkbox, the select-all master,
    // and all nine condition checkboxes (seeded on for scope-all).
    const all = inputByLabel("Device 1 all events");
    expect(all.checked).toBe(true);
    expect(inputByLabel("worker down").checked).toBe(true);
    expect(inputByLabel("finished").checked).toBe(true); // aria-labels are the human phrases

    setCheckbox(inputByLabel("worker down"), false);
    btn("Save scope")!.click();
    await waitFor(() => expect(patches().length).toBe(1));

    const patch = patches()[0];
    expect(patch.url).toBe(`/vh/notify/tokens/${TOK1.id}`);
    const headers = patch.init!.headers as Record<string, string>;
    expect(headers["X-VH-CSRF"]).toBe("1");
    // Wholesale: enabled + the eight remaining kinds in canonical order.
    expect(JSON.parse(patch.init!.body as string)).toEqual({
      scope: {
        enabled: true,
        conditions: [
          "permission_pending",
          "question_pending",
          "worker_missing",
          "project_missing",
          "session_error",
          "session_retry",
          "session_unread",
          "session_done",
        ],
      },
    });
  });

  it("zero selected requires the explicit confirm whose text states the wire truth ([] = ALL nine)", async () => {
    const { patches } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 scope").click();

    // Master unchecked → all nine off. A first Save does NOT patch: the
    // confirm must appear first (empty selection is explicit).
    setCheckbox(inputByLabel("Device 1 all events"), false);
    btn("Save scope")!.click();
    await waitFor(() => expect(document.body.textContent).toContain("ALL nine kinds"));
    expect(patches().length).toBe(0);

    // Confirm → PATCH sends the empty list (all-nine on the wire).
    btn("Save empty (all events)")!.click();
    await waitFor(() => expect(patches().length).toBe(1));
    expect(JSON.parse(patches()[0].init!.body as string)).toEqual({
      scope: { enabled: true, conditions: [] },
    });
  });
});

describe("NotifyDialog — delete confirm flow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("delete asks first (unrecoverable + re-enroll), then DELETEs with CSRF and refreshes", async () => {
    const { deletes, tokenGets } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 delete").click();

    await waitFor(() => {
      expect(document.body.textContent).toContain("cannot be recovered");
      expect(document.body.textContent).toContain("re-enroll");
    });
    expect(deletes().length).toBe(0); // no request before the confirm

    btn("Delete permanently")!.click();
    await waitFor(() => expect(deletes().length).toBe(1));
    const del = deletes()[0];
    expect(del.url).toBe(`/vh/notify/tokens/${TOK1.id}`);
    expect((del.init!.headers as Record<string, string>)["X-VH-CSRF"]).toBe("1");
    await waitFor(() => expect(tokenGets().length).toBe(2));
  });
});

describe("NotifyDialog — test send (row + raw token; result and 429)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("row Test POSTs {id} with CSRF and surfaces {sent, transport} inline", async () => {
    const { tests } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 test").click();
    await waitFor(() => expect(tests().length).toBe(1));

    const test = tests()[0];
    expect(test.url).toBe("/vh/notify/test");
    expect((test.init!.headers as Record<string, string>)["X-VH-CSRF"]).toBe("1");
    expect(JSON.parse(test.init!.body as string)).toEqual({ id: TOK1.id });

    await waitFor(() => expect(document.body.textContent).toContain("✓ Sent via fcm"));
  });

  it("a failed send surfaces the sanitized error verbatim", async () => {
    stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
      test: { status: 200, body: { schema: 1, sent: false, transport: "fcm", error: "send failed: HTTP 404 (NOT_FOUND)" } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 test").click();
    await waitFor(() =>
      expect(document.body.textContent).toContain("✗ send failed: HTTP 404 (NOT_FOUND)"),
    );
  });

  it("429 surfaces the server's wait hint plus the Retry-After header", async () => {
    stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
      test: {
        status: 429,
        text: "test-send rate limit: wait 10s before the next test send",
        headers: { "Retry-After": "10" },
      },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    btnByLabel("Device 1 test").click();
    await waitFor(() => {
      expect(document.body.textContent).toContain("test-send rate limit: wait 10s");
      expect(document.body.textContent).toContain("(retry after 10s)");
    });
  });

  it("raw-token test in the Add section POSTs {token} — works before registration", async () => {
    const { tests } = stubNotify({});
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add device")).toBeTruthy());
    setInput(inputByLabel("New device token"), "fcm-raw-0000000000001");
    btnByLabel("Test unregistered token").click();

    await waitFor(() => expect(tests().length).toBe(1));
    expect(tests()[0].url).toBe("/vh/notify/test");
    expect(JSON.parse(tests()[0].init!.body as string)).toEqual({
      token: "fcm-raw-0000000000001",
    });
    await waitFor(() => expect(document.body.textContent).toContain("✓ Sent via fcm"));
  });
});

describe("NotifyDialog — 409 disabled posture (--notify-store off)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the whole dialog flips read-only with the off-hint naming the flag", async () => {
    stubNotify({
      getTokens: {
        status: 409,
        text: "notification registry is not configured: no --notify-store path is set on this controller",
      },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Push notifications are off");
      expect(document.body.textContent).toContain("--notify-store");
    });
    // Read-only posture: no inputs, no mutation affordances, no history
    // empty-state text (that would read as "enabled but quiet").
    expect(document.querySelectorAll("input").length).toBe(0);
    expect(btn("Add device")).toBeUndefined();
    expect(document.body.textContent).not.toContain("No notifications yet");
    // The transport flag is named too (test sends need credentials).
    expect(document.body.textContent).toContain("--notify-fcm-credentials");
  });
});

describe("NotifyDialog — history render", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders newest-first with color-coded action chips and expandable deliveries", async () => {
    stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
      history: { status: 200, body: HIST },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("5 questions pending"));
    // Newest-first: changed (1h→id3 is 30m ago…) — order by DOM position.
    const text = document.body.textContent || "";
    const iChanged = text.indexOf("5 questions pending");
    const iCleared = text.indexOf("session errors (cleared)");
    const iAppeared = text.indexOf("2 workers down");
    expect(iChanged).toBeGreaterThanOrEqual(0);
    expect(iCleared).toBeGreaterThan(iChanged);
    expect(iAppeared).toBeGreaterThan(iCleared);

    // Action chips carry the color-coded classes.
    const chip = (frag: string) => {
      const el = Array.from(document.querySelectorAll(`.${styles.chip}`)).find((c) =>
        (c.textContent || "").includes(frag),
      );
      expect(el, `chip ${frag}`).toBeTruthy();
      return el!;
    };
    expect(chip("appeared").classList.contains(styles.chipAppeared)).toBe(true);
    expect(chip("changed").classList.contains(styles.chipChanged)).toBe(true);
    expect(chip("cleared").classList.contains(styles.chipCleared)).toBe(true);

    // Count + relative ts render (fixture id2 is 60s old → "1m ago",
    // stable however slow the suite runs).
    expect(document.body.textContent).toContain("×5");
    expect(document.body.textContent).toContain("1m ago");

    // Deliveries are collapsed until the toggle; then per-token outcomes.
    expect(document.body.textContent).not.toContain("✓ delivered");
    btnByLabel("Deliveries event 2").click();
    await waitFor(() => {
      expect(document.body.textContent).toContain("00112233…");
      expect(document.body.textContent).toContain("HTTP 500: backend error");
      expect(document.body.textContent).toContain("retired (unregistered)");
    });
    // The ok delivery on the OTHER event stays collapsed until asked.
    btnByLabel("Deliveries event 3").click();
    await waitFor(() => expect(document.body.textContent).toContain("✓ delivered"));
  });

  it("empty history (200, no events) shows the quiet empty state", async () => {
    stubNotify({});
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("No notifications yet"));
  });
});

describe("AdminMenu — Push notifications entry wiring", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the 'Push notifications' entry opens the dialog while the menu stays mounted", async () => {
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
        if (url.includes("/vh/notify/tokens")) return Promise.resolve(respJson({ schema: 1, tokens: [] }));
        if (url.includes("/vh/notify/history"))
          return Promise.resolve(respJson({ schema: 1, events: [], first_id: 0, last_id: 0 }));
        return Promise.resolve(respJson({}));
      }),
    );
    render(() => <AdminMenu onClose={() => {}} />);

    const entry = await waitFor(() => {
      const b = btn("Push notifications");
      expect(b).toBeTruthy();
      return b!;
    });
    expect(entry.classList.contains("admin-btn")).toBe(true);

    entry.click();
    await waitFor(() =>
      expect(document.querySelector('.dialog[aria-label="Push notifications"]')).toBeTruthy(),
    );
    // The admin menu itself is still mounted behind the portaled dialog.
    expect(document.querySelector(".admin-menu")).toBeTruthy();
    // The dialog loaded the registry (Devices + Add sections render).
    await waitFor(() => {
      expect(document.body.textContent).toContain("Devices");
      expect(document.body.textContent).toContain("Add device");
    });
  });
});
