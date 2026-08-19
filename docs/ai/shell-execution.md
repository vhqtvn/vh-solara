# Shell Execution Guide

This document defines the rules, verb contracts, and forbidden patterns for agent-driven shell execution. It is the canonical reference for the `shell-guard` plugin's enforcement rationale and command hygiene.

## The `exec-family` Verb Contracts

The agent harness provides distinct verbs for execution. They MUST NOT be unified or aliased. OpenCode's permission matching is verb-based, so collapsing them would break their respective safety guarantees.

- **`exec-ro`**: Classifier-proven, prompt-free read-only inspection. Safe for agents to use without interrupting the operator.
- **`exec-sandbox`**: Host-local execution, kernel-enforced only when its sandbox is active. It does NOT follow a command into `proxy` or `docker_compose` backends. By design, its seccomp profile blocks `socket(2)`.
- **`exec`**: Genuine mutation or runtime/backend execution.
- **`shell`**: Interactive shell. Avoid using this unless explicitly requested by a human.

## Forbidden Patterns

The `shell-guard` plugin actively refuses high-risk command patterns. When a rule fires, read the rule's rationale (`why`) and pick the canonical alternative. **Do not paraphrase the command to evade the guard.** If you are blocked by a legitimate need, escalate to the operator.

### Core Rules (Always Active)

The following patterns are denied by the generic core rules (`forbidden-patterns.core.js`):
- **`apt-install-ad-hoc`**: Ad-hoc package installations (`apt-get install`).
- **`user-group-mutation`**: User and group modifications.
- **`ssh-host-key-bypass`**: Bypassing SSH host key checking (`StrictHostKeyChecking=no`).
- **`scp-upload`**: SCP upload deployments.
- **`system-tmp-access`**: ANY reference to the system `/tmp` directory. All temporary files must live in the repo-scoped `./tmp/`.
- **`git-mutation-bypass`**: Ad-hoc git mutation commands (see *Git Operations* below).

### Project Overlay Examples

The plugin supports project-specific overlays (`forbidden-patterns.project.js`) to refuse domain-specific risks. While these are configurable per project, examples of what the plugin is built to refuse include:
- Docker socket access
- Cloud-provider lifecycle on Terraform-managed resources
- Raw database writes against protected identity/auth tables
- Project JWT secrets on the command line

### Residual False-Positive Risk

A residual false-positive/evaporation gap exists for an `echo X && dangerous Y` chain shape. The chain is exempted by the leading `echo` because the `shell-guard` parser's per-command splitting behaves unexpectedly. This shape is adversarial and rare in practice. **Etiquette:** treat the guard's intent as signal; do not paraphrase or chain commands to evade it. Route around legitimate needs using single simple commands or the write tool as described in *Command Hygiene*.

## Command Hygiene

Most recurring permission prompts occur because a command cannot be safely parsed or uses an unsanctioned form. Follow these rules:

1. **Use the WRITE TOOL for files — never shell heredocs or redirection.**
   Write tool output to `./tmp/plan.json`. Do not use `cat <<EOF > file` or `printf > file`.
2. **Run SINGLE SIMPLE commands.**
   No `&&`-chains, brace-groups, multi-line `python3 -c`, or inline scripts. A chain parses as multiple commands, each requiring independent allowlisting. Write a script to `./tmp/` and execute it instead.
3. **Use sanctioned wrappers.**
   Prefer sanctioned wrappers like `.opencode/scripts/readonly-scripts.sh` instead of raw, ad-hoc system calls (e.g., `cat /proc/sys/...`).
4. **Env vars and `timeout` go INSIDE `bash -c`.**
   Use `vh-agent-harness exec bash -c 'FOO=bar timeout 300 pytest'`. Never use them as a host-shell prefix (e.g., `FOO=bar vh-agent-harness ...`) because the host prefix never reaches the container and is rejected by the guard.
5. **Repo-relative paths only.**
   Never hardcode absolute paths like `/home/<user>/...`. Always resolve paths relative to the project root. Absolute paths to external directories are the primary cause of `external_directory` permission prompts.

## Git Operations

All git mutations must be routed through the **`committer` subagent** (via the `gated-commit` skill). The `git-mutation-bypass` rule actively denies raw `git commit`, `git add`, `git branch`, or `git reset` commands attempted by other agents. Pass only the explicit file/path list for your authorized slice.

## The Network-Fetch Reality

No read-only agent execution surface may open a network socket:
- `exec-ro` has a fixed classifier set that explicitly omits `curl` and `wget`.
- `exec` is role-denied for ad-hoc script execution that could open sockets.
- `exec-sandbox` blocks `socket(2)` at the kernel level via seccomp (only when the sandbox is active — `--sandbox=off|best-effort|strict`, default `best-effort`; `--sandbox=off` means no kernel enforcement).

Therefore, **network fetches against local daemons are operator-only.** If you need telemetry, metrics, or internal API JSON, provide the exact `curl` one-liner to the operator and ask them to run it and paste the JSON back. Do not attempt to run it yourself.