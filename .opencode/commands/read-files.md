---
description: Read exact file contents for a small set of paths
agent: repo-explorer
subtask: true
---

Read the exact content of these files and return them verbatim:
$ARGUMENTS

Rules:
- default limit: 3 files per invocation
- if the request is larger, return batch 1 and list the remaining files for follow-up
- preserve exact text
- do not add summaries unless asked
