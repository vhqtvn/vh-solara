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
