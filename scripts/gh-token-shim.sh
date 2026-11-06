#!/bin/sh
# Installed as /usr/local/bin/gh in the image, ahead of the real /usr/bin/gh.
# A run's GitHub token expires after an hour and Conduit rewrites the file
# named by CONDUIT_GH_TOKEN_FILE with a fresh one. Reading it here keeps `gh`
# working even in shells that rebuilt PATH and so skip the per-run wrapper.
if [ -n "${CONDUIT_GH_TOKEN_FILE:-}" ] && [ -r "$CONDUIT_GH_TOKEN_FILE" ]; then
  IFS= read -r GH_TOKEN < "$CONDUIT_GH_TOKEN_FILE"
  export GH_TOKEN
fi
exec /usr/bin/gh "$@"
