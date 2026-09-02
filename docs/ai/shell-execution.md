# Shell execution — the exec-family golden rule and forbidden patterns

> This is the agent-side shell contract for this repo: how to run commands,
> which verbs exist, and the high-risk patterns the `shell-guard` plugin denies.
> The authoritative per-repo permission surface is this repo's own
> `opencode.jsonc` grants plus `.opencode/plugins/shell-guard.js` (which loads
> the rule engine and the deny list). This doc explains the shared contract
> those surfaces enforce.

## The golden rule

Run project commands through the `vh-agent-harness` exec-family verbs — never
host-level `python`, `pytest`, `npm`, `pnpm`, `yarn`, or `docker compose`
directly. Host-level invocations fall outside the permission model's parsed,
sanctioned path: they burn operator confirmation prompts, run against the wrong
environment (host instead of the project runtime), and cannot be classified for
safety.

The agent harness provides distinct verbs for execution. They MUST NOT be unified or aliased. OpenCode's permission matching is verb-based, so collapsing them would break their respective safety guarantees. Pick the narrowest verb that fits the work:

| Verb | What runs where | Safety boundary |
|------|-----------------|-----------------|
| `vh-agent-harness exec` | Inside the project runtime backend (host under `host-shell`; inside the container under `proxy`/`docker_compose`) | Genuine mutation allowed; only forbidden patterns and the commit-gate are blocked |
| `vh-agent-harness exec-ro` | Read-only intent, classified host-side BEFORE backend dispatch | Prompt-free allowlisted classifier; default-deny of anything not proven read-only; a DENY is final — never rerun the denied command through another verb |
| `vh-agent-harness exec-sandbox` | Host-local kernel sandbox (Landlock + seccomp) for arbitrary read-code | Writes outside `./tmp/` and network are physically impossible under a strict mode floor; host-local only — does not follow a command into `proxy`/`docker_compose` backends |
| `vh-agent-harness shell` | Interactive shell in the runtime | Not for agents — use only when a human explicitly asks for interactive use |

Command hygiene that keeps you on the sanctioned path:

- **Files via the Write tool, never shell heredocs or redirection** (`cat <<EOF`,
  `cat > file`, `printf > file`). This is a structural deny, not a style rule:
  heredoc-in-braces plus redirection cannot be safely parsed and is refused.
- **Env vars and `timeout` go INSIDE `exec bash -c '...'`**, never as a host
  prefix before the verb — a host prefix runs on the host and never reaches the
  container.
- **Scratch files under the repo's `./tmp/`** (see the `system-tmp-access` rule
  below), written with the Write tool.
- **Simple single commands over `&&`-chains.** A chain parses as N commands and
  each must independently match an allowlist entry; scripts you write to
  `./tmp/` and run as one invocation are the sanctioned form for multi-step work.
- **Use sanctioned wrappers.** Prefer sanctioned wrappers like `.opencode/scripts/readonly-scripts.sh` instead of raw, ad-hoc system calls (e.g., `cat /proc/sys/...`).

## Forbidden patterns

The `shell-guard` plugin refuses this high-risk list BEFORE any allowlist grant
is consulted — a configured `allow` cannot rescue a denied command. If a deny
fires, do NOT paraphrase or split the command to evade it: read the rule's
`why`, pick the canonical alternative, or surface the situation to the
operator. The rules live in `.opencode/repo-configs/forbidden-patterns.core.js`
(generic core) plus `.opencode/repo-configs/forbidden-patterns.project.js`
(project overlay); each carries the remedy the rule itself prescribes.

Core rules (every adopter):

| Pattern | Denied form | Canonical alternative |
|---------|-------------|----------------------|
| `apt-install-ad-hoc` | `apt-get install …` at runtime | Packages belong in the Dockerfile — add the dep and rebuild the image; runtime installs vanish on the next rebuild and create silent drift |
| `user-group-mutation` | `usermod` / `groupmod` / `groupadd` / `useradd` / `gpasswd` / `chpasswd` | Fix the image / compose file, not the running container |
| `ssh-host-key-bypass` | `ssh -o StrictHostKeyChecking=no` / `-o UserKnownHostsFile=/dev/null` | Run `vh-agent-harness ssh-trust <host>` once on the host (the remedy the rule itself prescribes; the verb is pending CLI implementation), then ssh from inside with no flags |
| `scp-upload` | `scp … user@host:` deploys | Land changes via the configured release flow (git push + on-host pull, or container image rebuild) — scp leaves the host out of sync with git |
| `system-tmp-access` | any read/write of system `/tmp` | Use the repo `tmp/` (relative) for scratch, or `/workspace/tmp/` inside the dev container — out-of-repo writes trigger permission prompts and break unattended runs |
| `git-mutation-bypass` | raw `git add` / `commit` / `reset` / `push` / … | Git mutations route through the committer agent and `.opencode/scripts/commit-gate.sh` only (see `.opencode/docs/git-execution-routing.md` and *Git Operations* below) |

Project-overlay classes (a consuming project adds these in
`forbidden-patterns.project.js`; check your repo's own file for the live list):

- **Docker socket access** — mounting `/var/run/docker.sock` into the dev
  container, or `chmod`/`groupmod`/`usermod` on the socket or its group.
- **Cloud-provider lifecycle on Terraform-managed resources** — provider CLI
  mutating verbs (`<provider> <service> create/delete/update`); if Terraform
  lacks permissions, stop and ask the operator.
- **Raw database writes against protected/auth tables** and identity-table
  enumerations.
- **Project JWT secrets / token-forging material on the command line** —
  authenticate through the project's documented login flow with credentials
  sourced from env files, never inlined.

Agent charters (e.g. the build agent prompt) additionally forbid reading or
writing cloud-provider credential files (`~/.<provider>/credentials`, kube
configs) — cloud credentials must never reach the VPS. That is charter-level
discipline, not a core mechanical deny; a project wanting mechanical denial
adds a rule to `forbidden-patterns.project.js`.

**Residual FP-risk (documented in `forbidden-patterns.core.js`).** Read-only
inspector carve-outs exempt benign references to a trigger (`grep`/`echo`/
`which`/`ls` of the literal), and a leading-inspector chain-guard refuses the
carve-out whenever any shell control or substitution operator appears in the
command. The scan is naming-level, not adversarial-proof: an `echo X &&
dangerous Y` chain is exempted by the leading echo — adversarial, rare in
practice, and accepted as residual. If a benign form is denied, surface it to
the operator instead of restructuring the command to evade the deny.

## Repo-relative paths, never absolute home-dir paths

Always reference files repo-relative (`docs/...`, `tmp/...`, `.opencode/...`)
or resolve them from the project root. Enforcement rationale: hardcoded
absolute `/home/<user>/...` paths are the recurring cause of
`external_directory` permission prompts — a fat-fingered username produces an
out-of-project path, and the path-based matcher trips on it every time. The
`shell-guard` plugin resolves repo-relative paths against the repo root, so a
repo-relative reference matches the sanctioned convention exactly and the
prompt noise dies at the source.

## Git Operations

All git mutations must be routed through the **`committer` subagent** (via the `gated-commit` skill). The `git-mutation-bypass` rule actively denies raw `git commit`, `git add`, `git branch`, or `git reset` commands attempted by other agents. Pass only the explicit file/path list for your authorized slice.

## The Network-Fetch Reality

No read-only agent execution surface may open a network socket:
- `exec-ro` has a fixed classifier set that explicitly omits `curl` and `wget`.
- `exec` is role-denied for ad-hoc script execution that could open sockets.
- `exec-sandbox` blocks `socket(2)` at the kernel level via seccomp (only when the sandbox is active — `--sandbox=off|best-effort|strict`, default `best-effort`; `--sandbox=off` means no kernel enforcement).

Therefore, **network fetches against local daemons are operator-only.** If you need telemetry, metrics, or internal API JSON, provide the exact `curl` one-liner to the operator and ask them to run it and paste the JSON back. Do not attempt to run it yourself.

## Cross-references

- `.opencode/plugins/shell-guard.js` — the enforcement plugin (entry) and
  `shell-guard-core.js` (decision engine).
- `.opencode/repo-configs/forbidden-patterns.core.js` — the generic deny-rule
  source this doc summarizes (inspect it for the live regexes and carve-outs).
- `.opencode/docs/git-execution-routing.md` — the git-mutation routing rule and
  the committer agent's commit-gate protocol.
- `AGENTS.md` → "Shell, container, and workspace hygiene" — the operating-model
  summary that points here.
