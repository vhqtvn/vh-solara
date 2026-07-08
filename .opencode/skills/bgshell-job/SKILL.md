---
name: bgshell-job
description: Launch, monitor, stop, list, or resume long-running non-GPU local shell tasks without relying on one shell timeout. Use this when the user asks to run local build/release/maintenance commands that may outlive one shell call or one OpenCode session.
compatibility: opencode
---

# BG Shell Job

Use this for repo-local non-GPU shell work that may outlive one shell call or one OpenCode session.

## Required workflow

1. Prefer a session alias (`/session-start <alias>`), or pass `--session <alias>`.
2. Launch detached via helper:
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py launch --job <name> -- <command ...>`
3. Poll status/logs with short calls:
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py status --job <name> --lines 40`
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py logs --job <name> --lines 80`
4. Stop explicitly when needed:
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py stop --job <name> --force`
5. Recover after compaction/session loss:
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py list`
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py status --job-dir tmp/agent-runs/<alias>/bg-jobs/<name>`
   - `vh-agent-harness exec python .opencode/skills/bgshell-job/scripts/bgshell_job.py resume --job-dir tmp/agent-runs/<alias>/bg-jobs/<name>`

## Helper behavior

State is saved under:

- `tmp/agent-runs/<session-alias>/bg-jobs/<job-name>/job.json`
- `tmp/agent-runs/<session-alias>/bg-jobs/<job-name>/job.log`

## Output

- job id and session alias
- exact launch/status/stop/resume command used or recommended
- current state: `queued`, `starting`, `running`, `succeeded`, `failed`, `stopped`, `interrupted`
- smallest safe next step

## When not to use

- do not use this for GPU work
- do not use this for quick commands that complete inside one shell call
- do not use this as a substitute for CI or remote job scheduling
