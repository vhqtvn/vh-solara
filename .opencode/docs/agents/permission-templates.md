# Permission Templates

These templates are intended for `opencode.jsonc` hardening.

## 1) Read-only observer template

The `edit` block here is the shape the permconfig emitter produces for every
read-only (deny) agent: a broad `deny` first, then the universal `tmp/**`
allow last. `tmp/` is gitignored and watcher-ignored, so it is the sanctioned
disposable-scratch surface every agent may Write without a prompt while every
other edit decision stays denied (findLast — last match wins).

```jsonc
{
  "edit": {
    "*": "deny",
    "tmp/**": "allow"
  },
  "webfetch": "deny",
  "task": {
    "*": "deny",
    "commit-message": "allow"
  },
  "bash": {
    "*": "deny",
    "ls *": "allow",
    "find *": "allow",
    "rg *": "allow",
    "grep *": "allow",
    "sed -n *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "jq *": "allow",
    "git status *": "allow",
    "git show *": "allow",
    "git diff *": "allow",
    "git grep *": "allow",
    "git rev-parse *": "allow"
  }
}
```

## 2) Read-only audit-runner template

```jsonc
{
  "edit": "deny",
  "webfetch": "deny",
  "task": {
    "*": "deny",
    "commit-message": "allow"
  },
  "bash": {
    "*": "deny",
    "ls *": "allow",
    "find *": "allow",
    "rg *": "allow",
    "sed -n *": "allow",
    "jq *": "allow",
    "git status *": "allow",
    "git diff *": "allow",
    "vh-agent-harness exec pytest tests/unit/*": "ask",
    "vh-agent-harness exec node .opencode/scripts/normalize-backlog.js": "ask"
  }
}
```

Adjust the `vh-agent-harness exec ...` allowlist to exact repo-safe commands only.

## 3a) Read-only harness specialist template

For a specialist that may invoke `vh-agent-harness` only through its safe
read-only surface, set `"harnessPolicy": "read_only"` in the
permission-pack. The Go emitter renders the deny-first + canonical-allows-after
shape below automatically — do not hand-write the bash entries, because the
canonical verb list is Go-owned and may grow in future releases.

Permission-pack input (`.vh-agent-harness/overlays/<pack>/permission-pack.jsonc`):

```jsonc
{
  "agents": {
    "my-auditor": {
      "harnessPolicy": "read_only"
    }
  }
}
```

Rendered `opencode.jsonc` bash block (abbreviated — the full canonical list
has ~28 verbs):

```jsonc
{
  "bash": {
    "*": "deny",
    "ls *": "allow",
    "rg *": "allow",
    "git status *": "allow",
    "vh-agent-harness *": "deny",
    "vh-agent-harness exec-ro *": "allow",
    "vh-agent-harness doctor": "allow",
    "vh-agent-harness doctor *": "allow",
    "vh-agent-harness status": "allow",
    "vh-agent-harness docs *": "allow"
  }
}
```

The trailing `"vh-agent-harness *": "deny"` catches every non-canonical verb
(mutation, artifact, unknown); the specific `allow` entries after it win under
findLast. Mutation verbs (`exec`, `shell`, `update`, …) and broad wildcards
(`skill *`, `overlay *`) are excluded and stay denied. The legacy `harness` and
`devSh` keys also accept `"read_only"` for backward compatibility.

**Family read-only admission rule (`verb` + `verb *`).** Each admitted verb
appears as BOTH the scalar (`vh-agent-harness doctor`) and the wildcard
(`vh-agent-harness doctor *`) only because its ENTIRE family is currently
read-only — inspection flags, no mutating subcommands. `doctor`, `docs`,
`status`, `guide`, `proposals`, `version`, `example`, `sys-prompt`, `help`,
`diff`, and `preflight` all follow this shape. This is distinct from the
`skill *` / `overlay *` exclusion: those are withheld because they already
carry mutating verbs (`overlay new`; future skill verbs), so a family-wide
wildcard would leak a mutation to read-only specialists.

**Fail-open caveat.** Because the wildcard form is used, the matrix does NOT
deny a future subcommand of an admitted verb while `verb *` stays — a future
mutating `doctor <subcommand>` (e.g. a repair/write/network/secret-sensitive
path) would inherit the allow unless the family is re-audited. Admission of
`verb *` therefore carries a standing re-audit obligation; if the family gains
a mutator, narrow the wildcard to an explicit read-only subcommand allowlist
or move the mutating subcommand under a separate denied verb. Pre-emptive
narrowing while no mutator exists is hardening (parked), not a defect fix.

## 3) Editable specialist template

```jsonc
{
  "edit": "allow",
  "webfetch": "allow",
  "task": {
    "*": "deny",
    "commit-message": "allow"
  },
  "bash": {
    "*": "ask",
    "ls *": "allow",
    "find *": "allow",
    "rg *": "allow",
    "sed -n *": "allow",
    "git status *": "allow",
    "git diff *": "allow",
    "vh-agent-harness *": "allow"
  }
}
```

## 4) Internal-helper visibility template

```jsonc
{
  "agent": {
    "debate": {
      "mode": "subagent",
      "permission": {
        "task": {
          "*": "deny",
          "debate-*": "allow"
        }
      }
    },
    "debate-proposer": {
      "mode": "subagent",
      "hidden": true
    }
  }
}
```

## Rule ordering

Place `"*": "deny"` before narrower allow patterns. Last match wins.
