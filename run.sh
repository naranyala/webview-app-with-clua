#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_dir="$project_dir/build/desktop"
app="$build_dir/bin/metrics_desktop"

cmake -S "$project_dir" -B "$build_dir"
cmake --build "$build_dir" --target metrics_desktop
METRICS_RENDER_MODE="${METRICS_RENDER_MODE:-inline}" "$app"
