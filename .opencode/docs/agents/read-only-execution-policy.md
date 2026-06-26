# Read-Only Execution Policy

Read-only agents must be able to inspect and validate, but not mutate source, git state, or host-sensitive surfaces.

## Core idea

Read-only and no-shell are different concerns.

- read-only controls write/mutation rights
- shell policy controls command-risk surface

## Execution levels

### Level A: Observe

Use for pure reconnaissance.

- `edit: deny`
- `git *: deny` (or read-only subset only)
- `bash "*": deny`, then allow only inspection commands
- no project script execution

### Level B: Audit runner

Use for validation tasks that need command execution.

- same as Level A
- allow selected deterministic commands via `vh-agent-harness exec ...`
- still no file edits and no git mutation

### Level C: Builder

Use only for implementation agents.

- `edit: allow`
- `git *: ask`
- broader bash with ask/allow as needed

## Approved command style for read-only agents

Prefer:

- `ls`, `find`, `rg`, `sed -n`, `head`, `tail`, `jq`
- read-only git queries: `git status`, `git show`, `git diff`, `git grep`
- deterministic container checks via `vh-agent-harness exec ...` where explicitly allowed

Avoid broad interpreter permissions in read-only agents:

- `python *`
- `node *`
- `bash *`

If needed, pin exact script path patterns instead.

## Failure behavior rule

If permission blocks a needed command:

1. report exact blocked command
2. report why it is needed
3. request handoff to `build` or an editable specialist
4. do not attempt workaround commands
