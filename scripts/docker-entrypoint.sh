#!/bin/sh
set -eu

if [ -z "${DISPLAY:-}" ]; then
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
  export DISPLAY=:99
  sleep 0.5
fi

exec jean-server "$@"
