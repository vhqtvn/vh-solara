# Auth: secure-by-default login for published deployments

## Why

For *our own* deployment, the controller sits behind Nginx, which terminates TLS and
handles auth. That is deliberately **not** documented or depended on here. The problem
this doc solves is the **published** case: someone clones the repo and runs the binary
without Nginx, or without the experience to configure a reverse proxy securely. For that
operator, "set up forward-auth correctly" is itself the trap — the default failure mode of
self-hosted tools is *shipped wide open and exposed to the internet*.

So shipped auth has two goals:

1. It lives **in the binary**, not in a proxy the operator may not run.
2. It is **loud** about an unauthenticated public bind, so an operator can't expose the
   UI by accident without being told.

Everything else is about not opening a new invisible door while closing the visible one.

## Insecure-bind warning

At startup, `CheckBindSafety` classifies the bind:

- Bind is loopback (`127.0.0.1` / `::1`) → no auth required (dev), no warning.
- Bind is any other interface AND no auth method configured → **log a loud warning** and
  serve anyway. The warning states the UI (and, for the controller, every proxied worker)
  is reachable by anyone who can hit the address, and how to fix it.
- An auth method (incl. `trust-proxy`) configured → silent.

This deliberately *warns rather than refuses*: an expert who fronts their own auth/TLS
(e.g. Nginx) must keep working without app-level auth. The warning is the nudge; the
operator decides. (An earlier draft hard-failed; that broke the legitimate
reverse-proxy-fronted deployment, so it was downgraded to a warning.)

## Methods (secure-ranked), all through one session layer

1. **OIDC SSO** *(recommended default)* — operator supplies issuer + client ID/secret +
   an allowed-email/allowed-domain list. Delegates identity to a real IdP (Google, Okta,
   Auth0, Keycloak, Entra, Authentik). **No password store**, MFA inherited. This is the
   "more than username/password."
2. **Shared passphrase** *(fallback)* — for operators who can't stand up OAuth. Constant-
   time compare, then the *same* session as OIDC. Safe because it rides the vetted session
   layer, not a hand-rolled cookie.
3. **Trust-proxy header** *(opt-in, off by default)* — for experts running their own
   oauth2-proxy/Authelia. Reads an identity header **only** when `--auth-trust-proxy` names
   the trusted header and the app is bound private. Off by default so it can never be an
   *accidental* bypass.

## Libraries (don't hand-roll the dangerous parts)

- **`github.com/coreos/go-oidc/v3`** + **`golang.org/x/oauth2`** — OIDC discovery, PKCE,
  ID-token signature verification. Same verifier oauth2-proxy uses; small, auditable.
- **`github.com/alexedwards/scs/v2`** — **server-side** sessions. The cookie holds only an
  opaque ID; nothing forgeable rides in it. Secure flags (`HttpOnly`, `SameSite`,
  `Secure`-under-TLS) are the defaults. This is the part we must not hand-roll.
- CSRF on the auth POST: the OAuth `state` param covers the OIDC flow; the passphrase POST
  uses the existing `X-VH-CSRF` custom-header guard (login-CSRF on a single shared
  passphrase is low-risk).

No embedded full IdP (Keycloak/Kratos/Zitadel): huge operator burden and a larger attack
surface — the opposite of the goal.

## Where it sits

`pkg/auth` exposes one `Middleware(next http.Handler)` plus `/auth/login`,
`/auth/callback`, `/auth/logout`. Two public edges import it; nothing else in the repo
learns about auth:

- **Standalone agent daemon** (`pkg/web`) — the published single-host case. Hit directly;
  host-only cookie.
- **Controller** (`pkg/server`) — the multi-worker case. The controller is the single
  process that terminates every `<id>.domain`, so it is the natural auth edge: the OIDC
  client secret lives in one place, workers are reachable only through it, and it can set
  the shared cookie.

## Cookie model: auth shared, everything else isolated

The deliberate split (security *and* a product feature):

- **The session cookie is the only thing shared across subdomains.** Set with
  `Domain=.example.com` so one login is SSO across every `<id>.example.com` worker. Flags:
  `HttpOnly` (XSS on a worker page cannot read the token), `Secure`, `SameSite=Lax`.
- **`localStorage` / `sessionStorage` stay per-origin** — the browser isolates them by
  same-origin policy for free. Each worker keeps its own drafts, settings, history, theme.
  We must never widen this (no wildcard non-auth cookie, no `document.domain`).
- **Cookie `Domain` is configurable**: default **unset → host-only** (correct for a
  single-host install with no subdomains); set to the parent domain (derivable from the
  controller's existing `HostPattern`) for the wildcard deployment.

Because the auth cookie is shared, OIDC needs **no ticket/handshake bridge**: the code
exchange happens on one fixed auth origin (the only `redirect_uri` to register), and the
resulting `.example.com` cookie propagates to every subdomain. (A provider that allowed
wildcard redirect URIs is not required.)

## Invariants (the doors to keep shut)

Sharing the auth cookie makes all `.example.com` subdomains **one auth trust domain**.
A poisoned/agent-controlled worker page can't *steal* the token (HttpOnly), but the browser
will *attach* it to requests aimed at sibling subdomains (confused-deputy). The existing
defenses close this **only if** they hold end-to-end:

1. **CSRF + CORS must wrap the proxied surface, not just `/vh/*`.** Sibling subdomains are
   *cross-origin*, so the `X-VH-CSRF` custom-header requirement forces a preflight that
   strict CORS rejects; the simple-request gap is closed because a mutating request without
   the header is refused. Today `csrfGuard` already covers `/oc/*` (the OpenCode
   passthrough) and mutating `/vh/*`. **Audit item:** the terminal WebSocket upgrade
   (`pkg/web/terminal.go`) uses `CheckOrigin: return true` — with a shared credential it
   must instead reject cross-origin upgrades (check `Origin` against the request host).
2. **The CSRF token must stay per-origin.** Never deliver it via the shared (`.example.com`)
   cookie — keep it in per-origin `localStorage` or a host-only cookie. If a sibling could
   read the token, the custom-header defense collapses.
3. **Cookies change the "no credentials" CORS assumption** (`pkg/web/server.go` cors()).
   Keep cross-origin credentialed CORS **off** — the SPA is same-origin with its server, so
   the cookie is sent without any `Access-Control-Allow-Credentials`. Only revisit if a
   genuine cross-origin credentialed caller appears, and then never with `Allow-Origin: *`.

## Config surface

```
--auth-mode                      none | oidc | passphrase | trust-proxy   (none allowed on loopback only)
--auth-oidc-issuer               (oidc) Issuer URL, e.g. https://accounts.google.com   (default "")
--auth-oidc-client-id            (oidc) OAuth client ID   (default "")
--auth-oidc-client-secret        (oidc) OAuth client secret (prefer the VH_AUTH_OIDC_CLIENT_SECRET env var; never logged)   (default "")
--auth-oidc-redirect-url         (oidc) Absolute callback URL, e.g. https://app.example.com/auth/callback   (default "")
--auth-allowed-emails            (oidc) Allowed email address (repeatable / comma-separated)   (default unset)
--auth-allowed-domains           (oidc) Allowed email domain (repeatable / comma-separated)   (default unset)
--auth-passphrase                (passphrase) Shared passphrase (prefer the VH_AUTH_PASSPHRASE env var; never logged)   (default "")
--auth-trust-proxy               (trust-proxy) Identity header set by a fronting proxy, e.g. X-Forwarded-Email (requires private bind)   (default "")
--auth-cookie-domain             Session cookie domain; empty = host-only, .example.com = shared across worker subdomains   (default "")
--auth-cookie-secure             Set the Secure flag on the session cookie (disable only for plain-HTTP local testing)   (default true)
--auth-require-verified-email    (oidc) Require the IdP to assert email_verified even when the email matches the allow-list   (default false; env: VH_AUTH_REQUIRE_VERIFIED_EMAIL)
```

Secrets come from env by preference; never logged. Empty `--auth-mode` on a public bind is
the fail-closed error, not a silent open server.
