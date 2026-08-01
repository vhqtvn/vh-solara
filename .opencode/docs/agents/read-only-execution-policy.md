# Read-Only Execution Policy

Read-only agents must be able to inspect and validate, but not mutate source, git state, or host-sensitive surfaces.

## Core idea

Read-only and no-shell are different concerns.

- read-only controls write/mutation rights
- shell policy controls command-risk surface

A read-only agent that needs to RUN CODE (an interpreter, an AST walker, a
data-analysis script) is still a read-only agent — provided the code's
write+network surface is kernel-contained. That containment is what
`exec-sandbox` provides, and it is the canonical mechanism for Level B.

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
- **canonical mechanism: `vh-agent-harness exec-sandbox`** — the host-local
  Landlock + seccomp trampoline. A read-only agent that needs to run arbitrary
  read-code (a Python/Node/Bash interpreter, an AST/exploration script, a
  data-analysis tool) is granted `exec-sandbox` per-agent. Under a strict
  mode-floor (below), the kernel makes writes outside `./tmp/` and network
  access physically impossible, so the agent retains its read-only character
  even while running an interpreter.
- deterministic read-only container checks may still use `vh-agent-harness exec`
  where explicitly allowed
- still no file edits and no git mutation

The grant is safe ONLY because the mode-floor (below) kernel-contains the
executed code. The floor and the grant are paired invariants: relaxing the
floor requires re-reviewing every exec-sandbox grant.

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
- arbitrary read-code via `vh-agent-harness exec-sandbox` (Level B, see below)

### Running interpreters / read-code in read-only agents

Broad interpreter permissions in read-only agents (`python *`, `node *`,
`bash *`) are unsafe as a bare grant — an interpreter can write anywhere and
make network calls, breaking the read-only contract.

Two mechanisms contain this:

1. **`exec-sandbox` (canonical, preferred).** Grant the read-only agent
   `vh-agent-harness exec-sandbox *` under a **strict mode-floor**
   (`exec_sandbox.min_mode: strict` in `run-shape.yml`). The strict floor
   forces `--sandbox=strict` (Landlock denies writes outside `./tmp/`) and
   `--net=deny` (seccomp denies network) regardless of the caller's flags. The
   agent can then run an arbitrary interpreter to read and analyze code/data,
   and write scratch to `./tmp/`, while the kernel enforces that nothing escapes.

   **This supersedes the "pin exact script paths" workaround** for the general
   read-code case. Pinning is fragile (every new script needs a new allowlist
   entry) and provides no structural containment — it relies on the operator
   having pinned a safe-enough path. exec-sandbox provides kernel-enforced
   containment that holds even for arbitrary code.

2. **Pin exact script paths (legacy fallback).** When no strict floor is
   configured (e.g. a host without Landlock, or a project that has not opted
   into the floor), the fallback is to allow only specific, audited script
   invocations rather than a broad interpreter wildcard. This remains valid but
   is the weaker, path-trust-based mechanism.

Do NOT flip a broad interpreter wildcard to `ask` in a read-only agent as a
substitute for either mechanism — LLM adjudication is accepted for soft
mutation judgment but is NOT trusted to gate arbitrary interpreters.
Structural (kernel) containment is preferred where it applies.

### Mode-floor requirement (mandatory for exec-sandbox grants)

A `vh-agent-harness exec-sandbox *` grant in a read-only agent is safe ONLY
under a strict floor. The floor is **binary-enforced**, not a permission-string
glob (flag parsing is too fragile: `--sandbox=off`, duplicate/interspersed
`--sandbox` flags). The binary reads `exec_sandbox.min_mode` from
`run-shape.yml` and clamps the effective mode UP so a caller can never
downgrade below the configured minimum.

- **strict floor** forces both `--sandbox=strict` (writes outside `./tmp/`
  impossible) and `--net=deny` (network impossible).
- **discovery** walks the ENTIRE ancestor chain from both the real (physical,
  symlink-resolved) cwd and the `--cwd` target, taking the MOST RESTRICTIVE
  floor found (not nearest-wins). A subdirectory invocation, an out-of-project
  `--cwd`, or a weakening child floor cannot escape an enclosing parent's
  strict floor.
- **fail-closed** — a present-but-broken floor (wrong type, value/key typo,
  YAML syntax error, directory at the path, or unreadable file) makes
  exec-sandbox REFUSE to run uncontained. Only a genuinely absent floor
  resolves to no-floor. Fail-closed if OS primitives are unavailable under a
  strict floor.

If the host lacks Landlock + seccomp, a strict floor fail-closes and the grant
is effectively inert (safe). Configure `min_mode: off` only if you accept that
exec-sandbox grants run uncontained — do not pair `min_mode: off` with a
read-only exec-sandbox grant.

## Failure behavior rule

If permission blocks a needed command:

1. report exact blocked command
2. report why it is needed
3. request handoff to `build` or an editable specialist
4. do not attempt workaround commands
