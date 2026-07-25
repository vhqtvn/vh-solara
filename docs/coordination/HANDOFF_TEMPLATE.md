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

Behavioral closure to preserve (if a load-bearing path was touched):
- carry any `behavioral-closure` declaration (verdict + crux) verbatim so the
  receiver does not re-derive it from memory; re-derive the crux's honesty only
  by re-running the repo-specific live verification, not by trusting the token
  (the token declares consistency; it does not prove the path executed).
- `verdict: proven` is honest only when the crux `result: proven`.

Motivation check to preserve (advisory, distinct property):
- when the task was driven by a stated motivation, carry whether it is now
  satisfied, in plain prose. This is advisory and is NEVER blended into the
  behavioral-closure token or a combined "closure passed" verdict.
```
