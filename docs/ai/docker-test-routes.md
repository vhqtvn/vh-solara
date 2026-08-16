# Docker test routes — lane 7 (host-web e2e)

Phase 1 of the docker dev-env plan (solution brief:
`tmp/agent-runs/researcher/docker-dev-env-brief.md`; Phase-0 probes:
`tmp/agent-runs/devenv-phase0-probes/report.md`). This is the first
Docker-backed local route for one test lane; later phases extend the pattern to
the other lanes. It exists so the full three-engine host-web e2e matrix is
locally runnable with **zero host toolchain dependence**.

## Principle: never rely on the host toolchain

Project toolchains and browser/system dependencies must not depend on host
state. CI does not substitute for local reproducibility. For this route the
**only** host prerequisites are:

- a working Docker daemon + CLI,
- a repo checkout,
- `host-web/node_modules` — and even that is optional: the target installs it
  inside the container (via `npm ci`) when missing.

Host Node, host Playwright browsers, and host browser system libraries are NOT
prerequisites for this route.

## The command

```bash
# Operator route — full lane 7 (chromium + firefox + webkit), serial:
make test-host-web-docker

# Scoped to one engine (ARGS forwards verbatim after `playwright test`):
make test-host-web-docker ARGS='--project=webkit'

# Agent route (prompt-free under the harness exec family):
vh-agent-harness exec make test-host-web-docker
vh-agent-harness exec make test-host-web-docker ARGS=--project=webkit
```

The image pin lives in exactly one place — the `PLAYWRIGHT_IMAGE` Make
variable — and can be overridden for experiments:

```bash
make test-host-web-docker PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.61.0-noble
```

**Pin coupling:** the image tag MUST track the exact `@playwright/test` version
pinned in `host-web/package.json` (currently `1.60.0`). The official image
ships the matching browser builds (chromium 1223 / firefox 1522 / webkit 2287
for 1.60.0) with `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` preset — no browser
download ever runs. When bumping the package version, bump the tag in the same
change. Note: the `web/` package has its own Playwright version range — this
image is proven for host-web (lanes 7) only; do not assume lane 6 reuse without
reconciling versions.

## How the wrapper behaves

- Runs the repo bind-mounted (`-v "$PWD":/repo`) with `--init`.
- Runs as the invoking user (`--user "$(id -u):$(id -g)"`) with
  `-e HOME=/tmp/pw-home` (writable, ephemeral) so artifacts under
  `tmp/agent-runs/host-web-playwright/` and the vite cache under
  `host-web/node_modules/.vite` stay user-owned and user-deletable — never
  root-owned.
- If `host-web/node_modules` is missing, runs `npm ci` inside the container
  first (fresh clones need nothing else).
- The suite self-bootstraps its vite/ws servers on `127.0.0.1:5173-5175`
  **inside the container's network namespace** — no ports published, no
  collision with host servers.
- No Docker socket is mounted anywhere; nothing is installed into the running
  container (dependencies live in the image; `npm ci` only writes project deps
  into the bind-mounted `host-web/node_modules`).

### One-time cleanup of legacy root-owned artifacts

Containers run before the UID/GID handling existed (e.g. the Phase-0 probes)
left root-owned files under `tmp/agent-runs/host-web-playwright/` and
`host-web/node_modules/.vite` that a user-UID container cannot overwrite and
the invoking user cannot delete. If you hit `EACCES` on those paths, clean them
once with a root container (symmetric with how they were created; no host sudo
needed):

```bash
docker run --rm -v "$PWD":/repo -w /repo mcr.microsoft.com/playwright:v1.60.0-noble \
  bash -c 'rm -rf tmp/agent-runs/host-web-playwright/output tmp/agent-runs/host-web-playwright/report host-web/node_modules/.vite'
```

## Fresh clone story

```bash
git clone <repo> && cd vh-solara
make test-host-web-docker
```

First run pulls the image (~40 s, 2.26 GiB — once), installs
`host-web/node_modules` in-container (seconds), then runs. No host Node, no
host browsers, no host Go.

## Cost expectations (measured 2026-08-16)

| Item | Cost |
|---|---|
| One-time image pull | ~40 s, 2.26 GiB on disk |
| Full three-engine suite (chromium+firefox+webkit) | ~6.6 min (392 passed / 7 skipped / 0 failed) |
| Scoped webkit-only | ~2.5 min (127 passed / 6 skipped / 0 failed) |
| Warm re-run savings | ≈ pull time only; the suite is compute-bound |

Chromium passed without `--ipc=host` (the suite is serial, one worker — shared
memory pressure stays low). If a future heavier chromium run misbehaves, prefer
adding `--ipc=host` to the wrapper's docker flags over any design change.

## Lane 4 stays host-orchestrated by design

`tests/e2e-docker/run.sh` (lane 4, docker gold) is itself a host-side Docker
orchestrator — it drives docker build/run/exec directly and must remain
outside any dev container. Never mount `/var/run/docker.sock` into a test
container and never use Docker-in-Docker to "containerize" it. Its route stays
`make e2e` / `bash tests/e2e-docker/run.sh`.

## Scope

Phase 1 covers lane 7 only. Extending the same pattern to the remaining lanes
(Go unit/integration/e2e, web unit/e2e, host-web preview/real-embed) is Phase
2+ — until those land with receipts, do not claim all-lane host independence.
