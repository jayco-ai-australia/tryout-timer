#!/bin/bash
# Pull, install if the dependencies changed, then build beside the live app and swap it in
# (scripts/build-and-swap.sh). Any failing step stops the deploy with a non-zero exit; the swap
# script itself checks that PM2 restarted j-motion and that the app answers before it reports
# success, and rolls back if it doesn't.
set -euo pipefail
cd /Users/jaycoai/Projects/tryout-timer

BEFORE="$(git rev-parse HEAD)"
git pull --ff-only

# Only when the pull changed them. `npm install` currently fails on a peer conflict (eslint 9 vs
# eslint-config-next 14's eslint ^7||^8) — the same conflict that breaks `npm run lint` — so
# running it on every deploy would stop every deploy. When dependencies DO change it runs, and
# until that conflict is fixed it will fail here, loudly, before anything is built.
if git diff --quiet "$BEFORE" HEAD -- package.json package-lock.json; then
  echo "Dependencies unchanged — skipping npm install."
else
  npm install
fi

scripts/build-and-swap.sh
echo "J-Motion deployed successfully."
