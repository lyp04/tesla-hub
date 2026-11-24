#!/bin/bash
# bash test/run.sh <outdir> <url>...  Load pages in a headless browser, screenshot them, report errors.
#   BROWSER=chrome (default; Google Chrome with H.264/AAC, image built from chrome.Dockerfile)
#   BROWSER=chromium (Playwright's Chromium, no H.264)
# Settings for shot.js (VW, VH, LOCALE, WAIT, ACTIONS, EVAL, ...) are passed through; see README.md.
set -e
here=$(cd "$(dirname "$0")" && pwd); repo=$(dirname "$here")
if [ "${BROWSER:-chrome}" = chrome ]; then
  image=tesla-hub-test-chrome:1.49.1; channel=chrome
  docker image inspect "$image" >/dev/null 2>&1 || docker build -q -t "$image" -f "$here/chrome.Dockerfile" "$here" >/dev/null
else
  image=mcr.microsoft.com/playwright:v1.49.1-noble; channel=
fi
[ -d "$here/node_modules/playwright" ] || docker run --rm -v "$here:/t" -w /t "$image" npm install --no-audit --no-fund --silent
envs=(); for v in WAIT WAIT2 EVAL ACTIONS INIT_FILE MOCK_LYRICS MOCK_LAST CHROME_ARGS COLOR VW VH LOCALE CPU_THROTTLE PROFILE_MS PROFILE_FN; do envs+=(-e "$v"); done
exec docker run --rm --network host --ipc=host "${envs[@]}" -e CHANNEL="$channel" \
  -v "$repo:/hub:ro" -v "$here:/t" -w /t "$image" node shot.js "$@"
