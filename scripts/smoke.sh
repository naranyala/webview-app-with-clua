#!/usr/bin/env bash
#
# Desktop smoke run (TODO-002): prove the real frontend-to-C path.
#
# The unit tests cover each piece in isolation; this script runs the real
# desktop host against the real built frontend in a real graphical session,
# once per render mode (file:// URL and inline set_html). The frontend runs
# the checks, prints one machine-readable verdict, and the host turns that
# verdict into its exit code, so the result is the app's own behavior rather
# than a grep of a log.
#
# Usage:
#   scripts/smoke.sh              build what is missing, run both modes
#   SMOKE_SKIP_BUILD=1 ...        run the existing artifacts as they are
#   SMOKE_TIMEOUT=90 ...          per-mode timeout in seconds (default 60)
#
# Requirements: a graphical session (DISPLAY or WAYLAND_DISPLAY), GTK, and the
# pinned WebView dependency. The workspace is redirected into a temporary
# directory, so a smoke run never reads or rewrites the real one.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$root/build"
desktop_dir="$build_dir/desktop"
binary="$desktop_dir/bin/metrics_desktop"
frontend_html="$root/frontend-vue/dist/index.html"
log_dir="$build_dir/smoke"
timeout_seconds="${SMOKE_TIMEOUT:-60}"

die() {
  printf 'smoke: %s\n' "$1" >&2
  exit 1
}

# --- preconditions ---------------------------------------------------------

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  die "no graphical session (DISPLAY and WAYLAND_DISPLAY are unset); a smoke run needs a real session"
fi

command -v timeout >/dev/null 2>&1 || die "coreutils timeout is required"

# --- artifacts -------------------------------------------------------------

if [ "${SMOKE_SKIP_BUILD:-0}" != "1" ]; then
  if [ ! -d "$root/frontend-vue/node_modules" ]; then
    printf 'smoke: installing frontend dependencies\n'
    (cd "$root/frontend-vue" && npm install --no-audit --no-fund)
  fi
  printf 'smoke: building the frontend\n'
  (cd "$root/frontend-vue" && npm run build)
  printf 'smoke: building the desktop host\n'
  cmake -S "$root" -B "$desktop_dir" >/dev/null
  cmake --build "$desktop_dir" --target metrics_desktop -j"$(nproc)" >/dev/null
fi

[ -x "$binary" ] || die "missing $binary (build the desktop host or drop SMOKE_SKIP_BUILD)"
[ -f "$frontend_html" ] || die "missing $frontend_html (build the frontend or drop SMOKE_SKIP_BUILD)"

mkdir -p "$log_dir"

# --- one run per render mode ----------------------------------------------

# run_mode <file|inline>
run_mode() {
  local mode="$1"
  local log="$log_dir/$mode.log"
  local isolated
  isolated="$(mktemp -d "${TMPDIR:-/tmp}/metrics-smoke-${mode}.XXXXXX")"

  printf 'smoke: %s mode (log %s)\n' "$mode" "${log#$root/}"
  set +e
  METRICS_SMOKE=1 \
    METRICS_RENDER_MODE="$mode" \
    XDG_DATA_HOME="$isolated/data" \
    XDG_CONFIG_HOME="$isolated/config" \
    XDG_CACHE_HOME="$isolated/cache" \
    timeout "$timeout_seconds" "$binary" >"$log" 2>&1
  local status=$?
  set -e

  local verdict
  verdict="$(grep -m1 '^SMOKE VERDICT ' "$log" || true)"

  if [ "$status" -eq 124 ]; then
    printf 'smoke: %s mode timed out after %ss\n' "$mode" "$timeout_seconds" >&2
    tail -n 20 "$log" >&2
    return 1
  fi

  if [ -z "$verdict" ]; then
    printf 'smoke: %s mode reported no verdict (exit %d)\n' "$mode" "$status" >&2
    tail -n 20 "$log" >&2
    return 1
  fi

  printf '  %s\n' "$verdict"
  if [ "$status" -ne 0 ] || ! printf '%s' "$verdict" | grep -q 'pass=1'; then
    printf 'smoke: %s mode FAILED (exit %d)\n' "$mode" "$status" >&2
    return 1
  fi

  # WebKit's helper processes can still flush caches for a moment after the
  # window closes, so cleanup is best effort and never fails the run.
  sleep 0.2 2>/dev/null || true
  rm -rf "$isolated" 2>/dev/null || true
  printf 'smoke: %s mode passed\n' "$mode"
}

status=0
for mode in file inline; do
  if ! run_mode "$mode"; then
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  printf 'smoke: both render modes passed\n'
fi
exit "$status"
