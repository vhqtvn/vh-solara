# Frontend Harness

Adapted from trueai-dev's frontend harness (a gated fixture mode + Playwright
e2e + repo-scoped artifacts), reshaped for our Go-daemon + SolidJS stack.

The principle we kept: **run the real code path against swappable data.** Rather
than mocking `fetch` in the browser, the fixture lane runs the *real* aggregator,
web server, and render pipeline against a fake OpenCode — so e2e exercises the
actual stack, no `opencode` binary required.

## The two lanes

### Fixture lane (default)
`tools/fixtureserver` wires `pkg/fixtures` (fake OpenCode: seeded sessions +
subsession, messages with markdown/tool parts, a working-tree diff, and a
prompt-driven streaming simulation) into the real `aggregator` + `web.Server`.

```bash
# Serve the built SPA + live /vh + /oc on :8099, backed by fixtures:
cd web && npm run build && (cd .. && go run ./tools/fixtureserver -addr 127.0.0.1:8099)
# or: web/scripts/fixture-web.sh   (build + serve in one step)
```

For hot-reload UI work, run Vite against the fixture server instead:
```bash
go run ./tools/fixtureserver -addr 127.0.0.1:8099 &
cd web && VH_DAEMON=http://127.0.0.1:8099 npm run dev
```

### Live lane
Point the same specs at a real `--web=vh` daemon:
```bash
cd web
PLAYWRIGHT_USE_EXISTING_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://<daemon> npm run test:e2e
```

## Commands

| Command (in `web/`) | What |
|---|---|
| `npm run test:unit` | Vitest unit tests (pure reducers in `src/lib/reduce.ts`) |
| `npm run test:e2e` | Playwright e2e, fixture-backed (auto-starts the fixture server) |
| `npm run test:e2e:headed` / `:ui` | Headed / UI mode for debugging |
| `npm run fixture-web` | Build + serve the fixture lane manually |

## Artifacts

Playwright writes traces, screenshots, video, and the HTML report under
`tmp/agent-runs/playwright/` (repo-scoped, gitignored). Override with
`PLAYWRIGHT_ARTIFACTS_DIR`. Trace on first retry; screenshot/video on failure.

## Requirements / gotchas

- **Node ≥ 24** for Playwright (its TS config loader needs ≥18.19; use Node 24).
  Vite build/unit tests run on 18 too, but standardize on 24.
- The fixture server runs the real Go stack, so `go run` needs the project's Go
  toolchain (go.mod pins 1.23).
- Keep fixtures production-shaped and update `pkg/fixtures` when the OpenCode
  contract changes, so e2e keeps reflecting reality. One canonical fixture set.

## Docker e2e — real opencode, fake LLM

The fixture lane uses a fake *OpenCode*. There is also a heavier lane that runs
the **real `opencode`** driven by a **fake LLM**, to verify the whole chain end
to end (real session → real opencode → fake model → real aggregator → vh API):

```bash
make e2e            # builds Dockerfile.e2e and runs tests/e2e-docker/run.sh
```

Pieces:
- `tools/fakellm` — an OpenAI-compatible server (`/v1/chat/completions`,
  streaming) returning a deterministic, echoing reply. No API key or real model.
- `tools/e2eserver` — spawns real `opencode serve` (configured via
  `tests/e2e-docker/opencode.json` to use the fake LLM as an
  `@ai-sdk/openai-compatible` provider) and runs the real aggregator + web
  server on top (no controller/tunnel).
- `Dockerfile.e2e` — installs the real `opencode`, builds the SPA + Go tools,
  and starts fakellm + e2eserver in a git workspace.

`run.sh` drives a real session and asserts the full flow. The fake LLM is
prompt-driven: markers select behaviour so each flow is deterministic.

1. **Text** — a plain prompt streams an assistant reply; verified via **both**
   `/vh/snapshot` and the live `/vh/stream`.
2. **Tool → diff** — `[[write]]` makes the model call the real `write` tool
   (overwrites README.md); asserts a completed `write` tool part *and* that
   `/oc/vcs/diff` shows the change.
3. **Subsession** — `[[task]]` makes the model call the real `task` tool
   (general subagent); asserts a child session (with `parentID`) appears in the
   tree.

The fake only emits tool calls on agentic turns (requests carrying a `tools`
array) and terminates with text when the last message is a tool result, so
helper calls (title generation) and subagent turns resolve cleanly without
recursion. opencode's `permission: "allow"` (in the e2e config) keeps tools from
blocking on approval.

## What the e2e smoke covers

`web/tests/e2e/smoke.spec.ts`: the sidebar tree shows subsessions eagerly;
opening a session renders server-highlighted markdown + tool parts; the Changes
view renders a git diff; sending a prompt streams an assistant response.
