---
description: Read-only repo exploration and codepath mapping
agent: repo-explorer
subtask: true
---

Map the repo for this question:

$ARGUMENTS

Default behavior:
- do not return full file contents
- prefer paths, ownership, call flow, and precise line ranges
- only read snippets needed to answer the question
- call out fallback paths, duplicate paths, or stale paths

Return:
- main files involved
- the flow between them
- which package owns what
- highest-risk logic
- exact next files and line ranges to read

Keep it read-only and concise.
