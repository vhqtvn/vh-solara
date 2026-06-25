# Security

This document covers VHSolara's security model: how the pieces trust each other,
the authentication options, and the browser-facing hardening. The full auth
design rationale is in [`documents/06-auth.md`](documents/06-auth.md).

## Trust model at a glance

- **Workers bind loopback.** A `client-daemon` (and the `opencode serve` it owns)
  listens only on `127.0.0.1`. It has **no inbound network exposure** — it is
  reachable only through the controller's tunnel, which the worker dials *out* to.
- **The controller is the single user-auth edge.** Browser traffic hits the
  controller (`vh-solara server`), which authenticates the user and reverse-proxies
  to the right worker. There is intentionally no separate user login on the worker.
- **The tunnel is authenticated by a shared registration secret** (see below), so
  a rogue process can't register itself as a worker.
- **`local-server` is single-host.** No controller, no tunnel — auth applies
  directly to the one bound address.

## Authentication

VHSolara ships with in-binary login, so it's safe to expose without a reverse
proxy. It applies to the controller (`server`) and to `local-server` via
`--auth-mode`. Three modes:

- **`oidc`** *(recommended)* — delegate to any OIDC provider (Google, Okta, Auth0,
  Keycloak, Entra). No password store; MFA is inherited from the provider.
  Requires an `--auth-allowed-emails` and/or `--auth-allowed-domains` allow-list.
- **`passphrase`** — a single shared passphrase (`--auth-passphrase`, or the
  `VH_AUTH_PASSPHRASE` env var) for quick setups.
- **`trust-proxy`** — *opt-in*; trust an identity header (e.g. `--auth-trust-proxy
  X-Forwarded-Email`) set by your own oauth2-proxy / Authelia. Off by default so it
  can never become an accidental bypass; pair it with a private/loopback bind.

Example (controller with Google SSO, one login shared across all worker subdomains):

```bash
vh-solara server --addr :8080 --daemon-addr :8081 --host-pattern '$ID.mysite.com' \
    --auth-mode oidc \
    --auth-oidc-issuer https://accounts.google.com \
    --auth-oidc-client-id "$OIDC_CLIENT_ID" --auth-oidc-client-secret "$OIDC_CLIENT_SECRET" \
    --auth-oidc-redirect-url https://app.mysite.com/auth/callback \
    --auth-allowed-domains mysite.com \
    --auth-cookie-domain .mysite.com
```

### Session cookie

The session is server-side (the cookie holds only an opaque ID) and set
`HttpOnly` + `Secure` + `SameSite=Lax`. Its scope is `--auth-cookie-domain`:

- empty → **host-only** (correct for a single host / `local-server`);
- `.mysite.com` → **shared across worker subdomains**, so one login is SSO across
  every worker, while each subdomain keeps its own per-origin `localStorage`.

Secrets are read from the environment (`VH_AUTH_OIDC_CLIENT_SECRET`,
`VH_AUTH_PASSPHRASE`) in preference to flags so they don't appear in process args.

### Fail-soft on an insecure bind

A non-loopback bind with `--auth-mode none` logs a loud startup warning (the UI —
and, for the controller, every proxied worker — is reachable by anyone who can hit
the address) but **still serves**, so fronting auth/TLS at your own reverse proxy
is fully supported. To silence it: configure an auth method, use `trust-proxy`, or
bind loopback.

## Worker registration secret

`--worker-secret` on the controller (or the `VH_WORKER_SECRET` env var) requires
each `client-daemon` to present a matching `--controller-secret` (or
`VH_CONTROLLER_SECRET`), sent as the `X-VH-Worker-Secret` header and checked in
constant time, before it can register. This is independent of user auth and guards
the separate worker-registration listener (`--daemon-addr`) against rogue worker
registration / subdomain squatting. Empty (the default) = open registration —
only safe when that listener isn't reachable by untrusted parties.

## Browser-facing hardening

**CSRF.** State-changing API requests (`/oc/*` and mutating `/vh/*`) require a
custom `X-VH-CSRF: 1` header. The web UI sends it automatically; a cross-site page
can't (the browser would need a CORS preflight the server never approves), so a
malicious page can't drive the `/oc` passthrough — which can run shell commands —
through your browser. Scripts hitting the API directly must set this header. Reads
and the side-effect-free `/vh/render` are exempt. The terminal WebSocket upgrade is
same-origin only (it can't carry the CSRF header).

**CSP + headers.** Every response carries a `Content-Security-Policy` plus
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
`Referrer-Policy: no-referrer`. The CSP lists **no external origins** in
`script-src` / `connect-src` / `img-src` / `default-src`, so an injected script
can't load external resources or exfiltrate to other origins. (`script-src` still
allows inline/eval; tightening it to `'self'` is a follow-up.)

**CORS.** Cross-origin access is off by default (strict same-origin). To allow a
separate app/frontend, pass `--cors-origin https://app.example.com` (repeatable;
`*` allows any, which relaxes the cross-origin CSRF guard). Allowed origins receive
full CORS including the `X-VH-CSRF` header.

## Repo-declared managed processes (workspace trust)

A project may declare companion processes in a checked-in
`.vh-solara/project.jsonc` (a board, a docs server, …) that vh-solara starts and
reverse-proxies for the lifetime the project is open. Because these are **shell
commands authored in the repository**, running them is gated by a workspace-trust
model modelled on editor workspace trust:

- **Default posture: do not execute.** On first open the config is parsed but the
  declared commands are *not* run. The project enters an `awaiting-trust` state
  and the UI shows a review card listing the **exact command, working directory,
  environment keys, restart policy, and socket/prefix** of each process — display
  happens *before* any execution.
- **Grant is an explicit, authenticated action.** Only the browser-authenticated
  user can approve (the grant endpoint is behind the same CSRF guard and user-auth
  edge as every other mutating `/vh/*`). There is no auto-approval on open.
- **Per-project, per-config-hash.** The grant is recorded against the project
  directory (canonicalised through symlinks to block alias bypass) *and* the
  sha256 of the config's canonical JSON. Editing the config re-gates it; an
  unchanged config is not re-prompted across daemon restarts.
- **Runs as the daemon user.** Approved processes inherit the `client-daemon`'s
  uid, environment, and filesystem/network access — identical to what the
  existing `/oc` passthrough (and its shell) can already do. The trust gate is
  the sole new guard; it does not sandbox. Treat a project you grant the same as
  any other code you run from it.
- **Headless escape hatch.** `--trust-on-open` (or `VH_TRUST_CONFIG=1`) auto-grants
  on discovery for single-operator setups, with the same loud startup warning as
  an insecure bind. Use only on hosts you fully control.

## Trust boundaries (single authenticated operator)

vh-solara is a **single-trusted-user daemon**: anyone who passes auth is treated
as the operator who runs it, with the same reach as a shell on the host. Two
capabilities follow from that by design — call them out so they aren't mistaken
for bugs:

- **`?dir=` is the operator's whole filesystem.** Code-view and git endpoints
  act on the directory in `?dir=`/`x-opencode-directory`. Paths are confined
  *within* that directory (`safeJoin` rejects `..` traversal and symlinks that
  escape it — covered by tests), but the directory itself is operator-chosen, so
  an authenticated caller can read files and run git in any repo on the host.
  This matches what the `/oc` passthrough + its shell already allow. If the auth
  secret is shared or leaks, this is the blast radius — don't share it.
- **Embedded views proxy operator-registered upstreams.** A registered view
  reverse-proxies an arbitrary `unix:`/`http(s)://`/`tcp:` upstream. The proxy
  strips the vh-solara session cookie, drops the upstream's `Set-Cookie`, bounds
  the buffered HTML, and **blocks link-local dials (169.254/16, `fe80::/10`) so
  the cloud-metadata endpoint can't be reached**. It deliberately does *not*
  restrict loopback/LAN targets — proxying a board on `localhost`/the LAN is the
  feature. Treat the registration endpoint as operator-only.

## Reporting a vulnerability

Please report security issues privately via GitHub's **"Report a vulnerability"**
(Security → Advisories) on the [vh-solara repository](https://github.com/vhqtvn/vh-solara),
rather than opening a public issue. Include reproduction steps and the affected
version (`vh-solara version`).
