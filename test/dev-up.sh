#!/bin/bash
# dev-up.sh: build the bilibili mirror from this checkout and run it as a dev instance on
# 127.0.0.1:18480 (static files mounted, so boot.js / player.js changes need no rebuild).
# MENU_URL=... bash test/dev-up.sh shows the tab back to the menu.
set -e
here=$(cd "$(dirname "$0")" && pwd); repo=$(dirname "$here")
docker build -q -t tesla-hub-bili:dev "$repo/bili" >/dev/null
mkdir -p "$here/out/dev-data" && chmod 777 "$here/out/dev-data"
docker rm -f tesla-hub-bili-dev >/dev/null 2>&1 || true
docker run -d --name tesla-hub-bili-dev -p 127.0.0.1:18480:8080 -e DATA_DIR=/data -e MENU_URL="${MENU_URL:-}" \
  -v "$here/out/dev-data:/data" -v "$repo/bili/static:/app/static:ro" tesla-hub-bili:dev >/dev/null
for i in $(seq 1 20); do curl -sf -m 2 http://127.0.0.1:18480/__bili/healthz >/dev/null && break; sleep 0.5; done
echo "dev mirror on http://127.0.0.1:18480"
