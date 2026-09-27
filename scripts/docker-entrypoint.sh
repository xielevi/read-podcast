#!/bin/sh
set -eu

# Docker Compose creates a missing bind-mount source directory as root on Linux. The image
# itself runs the application as the unprivileged node user, so make only the manuscript
# mount root writable before dropping privileges. Generated subdirectories/files are then
# owned by node; existing user-managed content is not recursively chowned.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/manuscripts
  chown node:node /data/manuscripts
  exec su-exec node "$@"
fi

exec "$@"
