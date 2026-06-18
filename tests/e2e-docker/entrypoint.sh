#!/bin/sh
# Start the fake LLM, then the vh e2e server (which spawns real `opencode serve`
# in /work configured to use the fake LLM) and serve the web UI on :8099.
set -e

/usr/local/bin/fakellm -addr 127.0.0.1:11434 &

exec /usr/local/bin/e2eserver \
  -addr 0.0.0.0:8099 \
  -workdir /work \
  -opencode-bin /root/.opencode/bin/opencode
