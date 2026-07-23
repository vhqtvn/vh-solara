# Coordination Handoff Template

Use this when a task crosses lanes or pauses between sessions.

```text
Handoff:

Mission:

Primary lane:

Current owner:

Exact files in play:
- ...

What is already done:
- ...

What is still pending:
- ...

Blockers:
- ...

Load-bearing premises (value, source, re_derivation_command, observed_at):
- ...
The receiver MUST re-derive each premise above (run its re_derivation_command)
before acting on it; on disagreement the premise is stale and is re-adjudicated,
not silently re-asserted. (discipline, not a gate)

Required docs to reopen:
- docs/planning/backlog.md
- docs/planning/current-index.md
- relevant checkpoint(s)

Next recommended command:

Closeout shape to preserve:
Return:
1. ...
2. ...
```
