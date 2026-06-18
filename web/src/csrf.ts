// CSRF protection: tag every same-origin request with a custom header. The
// server requires it on state-changing API calls. A cross-site page can't set
// a custom header without a CORS preflight (which the server never approves),
// so only this same-origin SPA can reach the mutating endpoints — notably the
// /oc passthrough, which can run shell commands. Must run before any fetch.
import { projectDir } from "./sync";

const HEADER = "X-VH-CSRF";
const DIR_HEADER = "x-opencode-directory";

// Tag mutating /oc requests with the current project directory so OpenCode
// scopes writes to the selected project. (Reads/streams use ?dir=.)
function decorate(headers: Headers) {
  headers.set(HEADER, "1");
  const dir = projectDir();
  if (dir) headers.set(DIR_HEADER, dir);
  return headers;
}

// When auth is enabled and the session expires mid-use, the server answers API
// calls with 401. Bounce to the login page once (a navigation, so it resets the
// whole app) instead of letting fetches fail silently. Guarded so concurrent
// 401s don't fire multiple navigations.
let redirecting = false;
function onAuthExpired() {
  if (redirecting) return;
  redirecting = true;
  window.location.href = "/auth/login";
}

export function installCsrf() {
  const orig = window.fetch.bind(window);
  const wrap = (p: Promise<Response>) =>
    p.then((res) => {
      if (res.status === 401) onAuthExpired();
      return res;
    });
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    // The app only ever talks to its own origin, so tagging unconditionally is
    // safe and avoids missing a call site.
    if (input instanceof Request && init === undefined) {
      return wrap(orig(new Request(input, { headers: decorate(new Headers(input.headers)) })));
    }
    return wrap(orig(input, { ...(init ?? {}), headers: decorate(new Headers(init?.headers)) }));
  };
}
