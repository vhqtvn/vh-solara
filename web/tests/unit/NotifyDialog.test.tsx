// @vitest-environment jsdom
//
// Lane-5 coverage for the push-notification admin pane (NotifyDialog —
// reached from AdminMenu → "Push notifications"; FINAL S5 shape):
//   • masked device list render (label/preview/date/scope badge/
//     push-policy badge/telemetry) from the admin home GET
//     /vh/admin/notify/tokens — the masked-list wire now carries
//     push_policy (the public GET /vh/notify/tokens is the v4 probe
//     since S4 and never carries a list);
//   • add-device: POST /vh/notify/tokens with the exact body (token,
//     label, push_policy — the v4 FULL-STATE rule: the policy field is
//     always sent; the add form defaults to when_unattended and a Select
//     flip sends always) + CSRF header, then re-GET; the v4 success
//     envelope is {"ok":true}; a 503 {"ok":false,"error":"notify
//     unavailable"} flips the read-only disabled posture (the old 409
//     posture, relocated per v4 §3.1); client token validation mirrors
//     the server (byte bounds / printable ASCII) without a round-trip;
//   • enable/disable toggle + scope editor: PATCH wholesale scope body
//     (BOTH members) to the S5 ADMIN route /vh/admin/notify/tokens/{id}
//     (canonical order, all-nine → []); an EMPTY selection requires the
//     explicit confirm whose text states the wire truth ([] = ALL nine
//     kinds);
//   • delete: confirm step naming unrecoverability/re-enrollment, then
//     DELETE /vh/admin/notify/tokens/{id} with CSRF;
//   • test send: per-row {id} and raw-token {token} paths via POST
//     /vh/admin/notify/test; {sent, transport} surfaced inline; error
//     verbatim; 429 wait hint (body + Retry-After);
//   • 409 (--notify-store off): whole dialog read-only + off-hint;
//   • history: the v4 CENTRAL shape (GET /vh/notify/history →
//     {events, lastId, coverage}; ts a DECIMAL STRING of epoch ms):
//     newest-first render with label ("<worker> — <title>"), kind chip,
//     ×count, relative ts, and the ui_url worker anchor — plus the
//     worker-STANDALONE posture (ui_url/source omitted) rendering
//     without the anchor; empty state ("no notifications yet")
//     distinguished from the 409 posture;
//   • AdminMenu wiring: the "Push notifications" entry opens the dialog
//     while the menu stays mounted.
//
// Wire mirrors pkg/server/notify_http.go + notify_public_history.go;
// the server is the authority — the 400 test pins that its message wins
// verbatim.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import NotifyDialog from "../../src/components/NotifyDialog";
import AdminMenu from "../../src/components/AdminMenu";
import styles from "../../src/components/NotifyDialog.module.css";

const TOK1 = {
  id: "0011223344556677",
  label: "Operator phone",
  token_preview: "fcm-to…1234",
  push_policy: "always",
  created_at: "2026-09-20T10:00:00Z",
  last_used_at: "2026-09-27T09:00:00Z",
  last_error: "",
  scope: { enabled: true, conditions: [] },
};
const TOK2 = {
  id: "8899aabbccddeeff",
  label: "",
  token_preview: "fcm-tw…5678",
  push_policy: "when_unattended",
  created_at: "2026-09-21T10:00:00Z",
  last_used_at: null,
  last_error: "send failed: HTTP 404",
  scope: { enabled: false, conditions: ["worker_down", "session_error", "session_unread"] },
};

// v4 CENTRAL history fixture — ts is a DECIMAL STRING of epoch ms
// (goldens: pkg/server/testdata/notify_v4/history_response_v4.json).
// Ids ascend with time (the committed ledger's guarantee); id4 is the
// worker-STANDALalone posture (no ui_url / source) the same renderer
// must handle.
const NOW = Date.now();
const HIST = {
  events: [
    {
      id: 1,
      type: "waiting",
      sessionID: "ses-aaa",
      root: "/w/iris",
      project: "/w/iris",
      title: "fix the login flow",
      detail: "Permission request: bash*",
      ts: String(NOW - 3 * 3600_000),
      kind: "permission_pending",
      count: 2,
      label: "iris — fix the login flow",
      worker: { id: "iris", name: "iris" },
      source: { epoch: "iris-epoch-0002", seq: 3 },
      ui_url: "https://iris.localhost/app?session=ses-aaa&dir=%2Fw%2Firis",
    },
    {
      id: 2,
      type: "waiting",
      sessionID: "ses-bbb",
      root: "/w/bason",
      project: "/w/bason",
      title: "refactor the sync layer",
      detail: "Question: which shape?",
      ts: String(NOW - 3600_000),
      kind: "question_pending",
      count: 5,
      label: "bason — refactor the sync layer",
      worker: { id: "bason", name: "bason" },
      source: { epoch: "bason-epoch-0007", seq: 1 },
      ui_url: "https://bason.localhost/app?session=ses-bbb&dir=%2Fw%2Fbason",
    },
    {
      id: 3,
      type: "stalled",
      sessionID: "",
      root: "",
      project: "",
      title: "OpenCode",
      detail: "daemon-level: no heartbeat for 5m",
      ts: String(NOW - 1800_000),
      kind: "worker_down",
      count: 1,
      label: "iris — OpenCode",
      worker: { id: "iris", name: "iris" },
      source: { epoch: "iris-epoch-0002", seq: 4 },
      ui_url: "https://iris.localhost/app",
    },
    {
      id: 4,
      type: "waiting",
      sessionID: "ses-ccc",
      root: "/local",
      project: "/local",
      title: "standalone notice",
      detail: "served by the worker surface",
      ts: String(NOW - 60_000),
      kind: "session_unread",
      count: 1,
      label: "solo — standalone notice",
      worker: { id: "solo", name: "solo" },
    },
  ],
  lastId: 4,
  coverage: { complete: true, gaps: [] },
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

// Router-style fetch stub for the /vh/notify/* + /vh/admin/notify/*
// family (S5 final route split). Unspecified endpoints answer their
// empty 200 default; every call is recorded for method/header/body
// assertions. NOTE ordering: the admin matcher must run BEFORE the
// public one ("/vh/admin/notify/test" does not contain "/vh/notify/"
// as a substring, but keep the explicitness anyway).
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
    if (url === "/vh/admin/notify/test" && method === "POST") {
      return Promise.resolve(answer(cfg.test, { schema: 1, sent: true, transport: "fcm" }));
    }
    if (url.startsWith("/vh/admin/notify/tokens/") && (method === "PATCH" || method === "DELETE")) {
      // S5-relocated admin ops; 200 body is not consumed by the dialog.
      return Promise.resolve(answer(cfg.patch ?? cfg.del, {}));
    }
    if (url === "/vh/admin/notify/tokens" && method === "GET") {
      // The masked list's admin home — rows carry push_policy.
      return Promise.resolve(answer(cfg.getTokens, { schema: 1, tokens: [] }));
    }
    if (url === "/vh/notify/tokens" && method === "POST") {
      // The v4 public registration route answers exactly {"ok":true} on
      // success (never a created flag or token echo) and the
      // {"ok":false,"error":…} envelope on refusals.
      return Promise.resolve(answer(cfg.create, { ok: true }));
    }
    if (url.startsWith("/vh/notify/history")) {
      return Promise.resolve(answer(cfg.history, { events: [], lastId: 0, coverage: { complete: true, gaps: [] } }));
    }
    return Promise.resolve(respJson({}));
  });
  vi.stubGlobal("fetch", mock);
  const of = (method: string, frag: string) =>
    calls.filter((c) => (c.init?.method ?? "GET") === method && c.url.includes(frag));
  return {
    calls,
    posts: () => of("POST", "/vh/notify/tokens"),
    patches: () => of("PATCH", "/vh/admin/notify/tokens/"),
    deletes: () => of("DELETE", "/vh/admin/notify/tokens/"),
    tests: () => of("POST", "/vh/admin/notify/test"),
    tokenGets: () => of("GET", "/vh/admin/notify/tokens"),
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
// Drive the app's custom Select (see Select.test.tsx for the pattern):
// click the trigger (aria-label), then click the option whose trimmed
// text equals `label` in the <body>-portaled popup.
function selectOptionByLabel(ariaLabel: string, label: string): void {
  const trigger = document.querySelector(
    `.vh-select-btn[aria-label="${ariaLabel}"]`,
  ) as HTMLButtonElement | null;
  expect(trigger, `expected .vh-select-btn[aria-label="${ariaLabel}"]`).toBeTruthy();
  trigger!.click();
  const opt = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".vh-select-opt"),
  ).find((b) => (b.textContent || "").trim() === label);
  expect(opt, `expected an open Select option labeled ${label}`).toBeTruthy();
  opt!.click();
}

describe("NotifyDialog — devices list (masked render)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders masked rows: label/preview/date/scope badge + telemetry lines", async () => {
    const { tokenGets } = stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1, TOK2] } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("Operator phone"));
    // S4 migration pin: the list comes from the ADMIN home, never the
    // public GET /vh/notify/tokens (that is the v4 probe now).
    expect(tokenGets().length).toBeGreaterThanOrEqual(1);
    expect(tokenGets()[0].url).toBe("/vh/admin/notify/tokens");
    // Masked previews (mono), never raw tokens — the wire only carries these.
    expect(document.body.textContent).toContain("fcm-to…1234");
    expect(document.body.textContent).toContain("fcm-tw…5678");
    // Unlabeled hint + short created_at.
    expect(document.body.textContent).toContain("Unlabeled device");
    expect(document.body.textContent).toContain("2026-09-20");
    // Scope badges: enabled + all-events vs disabled + subset summary.
    expect(document.body.textContent).toContain("on · all events");
    expect(document.body.textContent).toContain("off · 3 of 9 events");
    // v4 push-policy badges (the masked list carries push_policy now):
    // one .badge per row names the policy EXACTLY (the scope badges
    // carry "·", the Select options carry "(default)").
    const badges = Array.from(document.querySelectorAll(`.${styles.badge}`));
    expect(
      badges.some((b) => (b.textContent || "").trim() === "always"),
      "expected an exact-'always' policy badge",
    ).toBe(true);
    expect(
      badges.some((b) => (b.textContent || "").trim() === "when unattended"),
      "expected an exact-'when unattended' policy badge",
    ).toBe(true);
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
      push_policy: "when_unattended", // v4 full-state: the field is ALWAYS sent
    });
    // Success note + the list is re-fetched.
    await waitFor(() => expect(document.body.textContent).toContain("✓ Device added"));
    await waitFor(() => expect(tokenGets().length).toBe(2));
  });

  it("defaults the policy Select to when_unattended; flipping to always sends push_policy always", async () => {
    const { posts } = stubNotify({});
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add device")).toBeTruthy());
    const trigger = document.querySelector(
      '.vh-select-btn[aria-label="New device push policy"]',
    ) as HTMLButtonElement;
    expect(trigger, "expected the push-policy Select").toBeTruthy();
    expect(trigger.textContent).toContain("when unattended (default)");

    setInput(inputByLabel("New device token"), "fcm-always-0000000001");
    selectOptionByLabel("New device push policy", "always");
    // The trigger reflects the pick.
    expect(trigger.textContent).toContain("always");

    btn("Add device")!.click();
    await waitFor(() => expect(posts().length).toBe(1));
    expect(JSON.parse(posts()[0].init!.body as string)).toEqual({
      token: "fcm-always-0000000001",
      label: "",
      push_policy: "always",
    });
  });

  it("a 503 notify-unavailable POST flips the read-only disabled posture (the v4-relocated 409)", async () => {
    const { posts } = stubNotify({
      create: { status: 503, body: { ok: false, error: "notify unavailable" } },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    await waitFor(() => expect(btn("Add device")).toBeTruthy());
    setInput(inputByLabel("New device token"), "fcm-willfail-000000001");
    btn("Add device")!.click();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Push notifications are off");
      expect(document.body.textContent).toContain("--notify-store");
    });
    // The refusal happened exactly once, and the add form is gone.
    expect(posts().length).toBe(1);
    expect(btn("Add device")).toBeUndefined();
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
    expect(patch.url).toBe(`/vh/admin/notify/tokens/${TOK1.id}`);
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
    expect(patch.url).toBe(`/vh/admin/notify/tokens/${TOK1.id}`);
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
    expect(del.url).toBe(`/vh/admin/notify/tokens/${TOK1.id}`);
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
    expect(test.url).toBe("/vh/admin/notify/test");
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
    expect(tests()[0].url).toBe("/vh/admin/notify/test");
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

  it("renders the v4 central shape newest-first: label, kind chip, ×count, ts, ui_url anchor", async () => {
    stubNotify({
      getTokens: { status: 200, body: { schema: 1, tokens: [TOK1] } },
      history: { status: 200, body: HIST },
    });
    render(() => <NotifyDialog onClose={() => {}} />);

    // Labels render verbatim (server-computed "<worker> — <title>").
    await waitFor(() => expect(document.body.textContent).toContain("bason — refactor the sync layer"));

    // Newest-first by DOM position: id4 (60s, standalone) → id3 (30m,
    // worker_down) → id2 (1h, question) → id1 (3h, permission).
    const text = document.body.textContent || "";
    const iSolo = text.indexOf("solo — standalone notice");
    const iNew = text.indexOf("iris — OpenCode");
    const iQ = text.indexOf("bason — refactor the sync layer");
    const iOld = text.indexOf("iris — fix the login flow");
    expect(iSolo).toBeGreaterThanOrEqual(0);
    expect(iNew).toBeGreaterThan(iSolo);
    expect(iQ).toBeGreaterThan(iNew);
    expect(iOld).toBeGreaterThan(iQ);

    // Kind chips: the neutral chip class carries the kind phrase (the
    // v4 central shape has no appeared/changed/cleared action anymore).
    const chips = Array.from(document.querySelectorAll(`.${styles.chip}`)).map(
      (c) => (c.textContent || "").trim(),
    );
    expect(chips).toContain("worker down");
    expect(chips).toContain("question pending");
    expect(chips).toContain("permission pending");
    expect(chips).toContain("unread"); // standalone event's kind
    // The retired color variants are gone from the module. The css-module
    // proxy fabricates a name for ANY key, so assert against the source
    // instead of property access.
    const cssSource = readFileSync(
      resolve("src/components/NotifyDialog.module.css"),
      "utf8",
    );
    for (const gone of [
      "chipAppeared",
      "chipChanged",
      "chipCleared",
      "deliv",
      "okText",
    ]) {
      expect(cssSource).not.toContain(gone);
    }

    // Detail renders as the secondary line (clamped at 90 chars — the
    // fixture's details are short, so verbatim).
    expect(document.body.textContent).toContain("daemon-level: no heartbeat for 5m");

    // Count only when > 1 (×5 on the question batch, ×2 on the permission
    // batch; no ×1 noise).
    expect(document.body.textContent).toContain("×5");
    expect(document.body.textContent).toContain("×2");
    expect(document.body.textContent).not.toContain("×1");

    // ts is a DECIMAL STRING of epoch ms — id4 is 60s old → "1m ago"
    // (stable however slow the suite runs); the raw digits never leak.
    expect(document.body.textContent).toContain("1m ago");
    expect(document.body.textContent).not.toContain(String(NOW - 60_000));

    // ui_url: controller events carry an anchor with the worker href;
    // the daemon-level event links the bare /app root.
    const links = Array.from(document.querySelectorAll(`a.${styles.evLink}`)) as HTMLAnchorElement[];
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://iris.localhost/app?session=ses-aaa&dir=%2Fw%2Firis");
    expect(hrefs).toContain("https://bason.localhost/app?session=ses-bbb&dir=%2Fw%2Fbason");
    expect(hrefs).toContain("https://iris.localhost/app");
    // Exactly three anchors — the STANDALONE event (ui_url omitted, the
    // worker-surface posture) renders NO link.
    expect(links.length).toBe(3);
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
        if (url.includes("/vh/admin/notify/tokens"))
          return Promise.resolve(respJson({ schema: 1, tokens: [] }));
        if (url.includes("/vh/notify/history"))
          return Promise.resolve(
            respJson({ events: [], lastId: 0, coverage: { complete: true, gaps: [] } }),
          );
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
