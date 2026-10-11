#!/bin/sh
set -eu

mkdir -p "$KARAOKE_DATA_DIR"
# Container PIDs can be reused after a crash. Hold a kernel lock before
# clearing stale PID locks, so a second container cannot run on this library.
# --no-fork keeps the launcher directly reachable by Docker's init process.
exec flock --nonblock --no-fork "$KARAOKE_DATA_DIR/.docker.lock" sh -c '
  rm -f "$KARAOKE_DATA_DIR/app.lock" "$KARAOKE_DATA_DIR/worker.lock"
  exec node scripts/launch.mjs --production --standalone
'
