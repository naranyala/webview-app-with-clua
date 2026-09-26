#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lua_command=${LUA:-lua}

if ! command -v "$lua_command" >/dev/null 2>&1; then
  printf "Lua executable '%s' not found. Set LUA to a Lua 5.3+ executable.\n" "$lua_command" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- run
fi

exec "$lua_command" "$project_dir/build.lua" "$@"
