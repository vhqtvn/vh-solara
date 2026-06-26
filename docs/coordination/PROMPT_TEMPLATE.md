# Coordination Prompt Template

Use this for non-trivial cross-boundary work.

```text
Task type:

Mission:

Important:

Settled assumptions:
- ...

Coordination mode:
- short | medium | long

Primary lane:

Suggested specialist:

In scope:
- ...

Out of scope:
- ...

Constraints:
- ...

Exact files likely to change:
- ...

Durable vs tmp:
- commit:
- tmp:

Validation:
- ...

Runtime layer:
- repo-only | workstream | local-runtime

Report envelope:
- minimal | standard | synthesis

Closeout expectations:
Return:
1. ...
2. ...
3. recommended next prompt

Waiting on:
- ...
```

Definition of Done items must be verifiable. Prefer Yes/No conditions tied to files, commands, tests, artifacts, or explicit decision outputs. Avoid vague phrases such as "works," "looks good," "cleaned up," or "done properly" unless paired with observable evidence.

For coordination-heavy closeout, use one of these report envelopes instead of a
freeform summary.

Minimal report:

```text
Return:
1. Task slice owned
2. Files in scope
3. Validation results
4. Blockers or none
5. Recommended next prompt
```

Standard report:

```text
Return:
1. Task slice owned
2. Files touched
3. Decisions made
4. Validation results
5. Blockers
6. Downstream dependencies
7. Durable updates needed
8. Recommended next slice
```

Synthesis report:

```text
Return:
1. Sessions consulted
2. Conflicting findings
3. Resolved view
4. Open risks
5. Durable updates required
6. Recommended next fan-out
```

For `/commit-review`, use this scoped review variant:

```text
/commit-review
Feature summary:
- ...

Primary lane:
- api

Exact file list:
- path/a
- path/b

File-cap override:
- no

Known dependencies or relevant repo rules/docs:
- ...

Review mode:
- merge-ready

Non-goals:
- ...

Validation already run:
- ...
```

If the review intentionally spans more than 8 files, change `File-cap override`
to `yes` and include a short reason.

The expected review output should also include:

- overall review confidence: `high`, `medium`, or `low`
- overall risk level: `low`, `medium`, or `high`
