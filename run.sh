#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir="$project_dir/build/desktop"
app="$build_dir/bin/metrics_desktop"

cmake -S "$project_dir" -B "$build_dir"
cmake --build "$build_dir" --target metrics_desktop

if [ "${METRICS_RENDER_MODE:-http}" = "http" ] && command -v python3 >/dev/null 2>&1; then
    server_port=${METRICS_HTTP_PORT:-4173}
    python3 -m http.server "$server_port" --bind 127.0.0.1 --directory "$project_dir/frontend-octane/dist" >/dev/null 2>&1 &
    server_pid=$!
    cleanup() {
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM
    METRICS_RENDER_MODE=http METRICS_FRONTEND_URL="http://127.0.0.1:$server_port/index.html" "$app"
else
    "$app"
fi
