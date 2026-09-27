local function shell_quote(value)
  return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local script = arg[0] or "build.lua"
local script_directory = script:match("^(.*)[/\\][^/\\]+$") or "."
local root = assert(io.popen("cd " .. shell_quote(script_directory) .. " && pwd"):read("*a"))
root = root:gsub("%s+$", "")

local function fail(message)
  error(message, 0)
end

local function run(command, cwd)
  local full_command = command
  if cwd then
    full_command = "cd " .. shell_quote(cwd) .. " && " .. command
  end
  print("$ " .. full_command)
  local ok, reason, code = os.execute(full_command)
  if ok == true or ok == 0 then
    return
  end
  local exit_code = type(ok) == "number" and ok or code or 1
  fail(string.format("Command failed with exit code %s: %s", tostring(exit_code), full_command))
end

local function executable_exists(name)
  local command = "command -v " .. shell_quote(name) .. " >/dev/null 2>&1"
  local ok = os.execute(command)
  return ok == true or ok == 0
end

local function require_executables(names)
  local missing = {}
  for _, name in ipairs(names) do
    if not executable_exists(name) then
      table.insert(missing, name)
    end
  end
  if #missing > 0 then
    fail("Missing required executables: " .. table.concat(missing, ", "))
  end
end

local function file_mtime(path)
  local process = io.popen("stat -c %Y " .. shell_quote(path) .. " 2>/dev/null")
  local value = process:read("*a")
  process:close()
  return tonumber(value)
end

local function is_newer(source, target)
  local source_time = file_mtime(source)
  local target_time = file_mtime(target)
  return source_time ~= nil and (target_time == nil or source_time > target_time)
end

local function install_frontend_dependencies()
  local frontend = root .. "/frontend-vue"
  local package = frontend .. "/package.json"
  local lockfile = frontend .. "/package-lock.json"
  local binary = frontend .. "/node_modules/.bin/rsbuild"
  local marker = frontend .. "/node_modules/.native-workspace-deps"
  if os.getenv("BUILD_SKIP_NPM_INSTALL") == "1" then
    return
  end
  if not executable_exists("npm") then
    fail("npm is required to install frontend dependencies")
  end
  if not file_mtime(binary) or not file_mtime(marker) or is_newer(package, marker) or is_newer(lockfile, marker) then
    run("npm install --no-audit --no-fund", frontend)
    run("touch " .. shell_quote(marker), frontend)
  end
end

local function trim(value)
  return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function read_command(command)
  local process = assert(io.popen(command))
  local output = trim(process:read("*a") or "")
  local ok, reason, code = process:close()
  if ok ~= true and ok ~= 0 then
    fail(string.format("Command failed: %s", command))
  end
  return output
end

local function pkg_config(package_name, field)
  return read_command("pkg-config --" .. field .. " " .. shell_quote(package_name) .. " 2>/dev/null")
end

local function flag_list(text)
  local flags = {}
  for flag in text:gmatch("%S+") do
    table.insert(flags, flag)
  end
  return flags
end

local function join_command(parts)
  local result = {}
  for _, part in ipairs(parts) do
    if part:match("^%-%-?[%w%+%.=/%-]+$") or part:match("^%-D[^%s]+$") then
      table.insert(result, part)
    else
      table.insert(result, shell_quote(part))
    end
  end
  return table.concat(result, " ")
end

local function build_c_target(kind, name, sources, output, options)
  options = options or {}
  local compiler = options.compiler or os.getenv("CC") or "cc"
  local parts = {
    compiler,
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-I" .. (options.include_directory or (root .. "/include")),
  }
  if kind == "shared" then
    table.insert(parts, "-fPIC")
    table.insert(parts, "-shared")
  end
  for _, include in ipairs(options.includes or {}) do
    table.insert(parts, "-I" .. include)
  end
  for _, define in ipairs(options.defines or {}) do
    table.insert(parts, "-D" .. define)
  end
  for _, source in ipairs(sources) do
    table.insert(parts, source)
  end
  table.insert(parts, "-o")
  table.insert(parts, output)
  for _, library in ipairs(options.libraries or {}) do
    table.insert(parts, library)
  end
  for _, library in ipairs(options.extra_libraries or {}) do
    table.insert(parts, library)
  end
  for _, flag in ipairs(options.flags or {}) do
    table.insert(parts, flag)
  end
  run(join_command(parts), root)
end

local function ensure_directory(path)
  run("mkdir -p " .. shell_quote(path), root)
end

local function build_c_shared_library(name, sources, options)
  options = options or {}
  local output = options.output or (root .. "/build/native/" .. name)
  ensure_directory(output:match("^(.*)/[^/]+$") or root)
  build_c_target("shared", name, sources, output, options)
  return output
end

local function build_c_executable(name, sources, options)
  options = options or {}
  local output = options.output or (root .. "/build/bin/" .. name)
  ensure_directory(output:match("^(.*)/[^/]+$") or root)
  build_c_target("executable", name, sources, output, options)
  return output
end

local function configure_desktop()
  require_executables({ "cmake" })
  local build_type = os.getenv("BUILD_TYPE") or "Release"
  local devtools = os.getenv("METRICS_ENABLE_DEVTOOLS") or "ON"
  run(
    "cmake -S "
      .. shell_quote(root)
      .. " -B "
      .. shell_quote(root .. "/build/desktop")
      .. " -DCMAKE_BUILD_TYPE="
      .. shell_quote(build_type)
      .. " -DMETRICS_ENABLE_DEVTOOLS="
      .. shell_quote(devtools)
  )
end

local function build_desktop()
  require_executables({ "cmake", "npm", "pdftotext", "pkg-config" })
  install_frontend_dependencies()
  configure_desktop()
  run("cmake --build " .. shell_quote(root .. "/build/desktop") .. " --target metrics_desktop --parallel")
end

local function make_command(target)
  local lua_command = os.getenv("LUA") or "lua"
  local lua_package = os.getenv("LUA_PKG") or "lua"
  return "make LUA=" .. shell_quote(lua_command) .. " LUA_PKG=" .. shell_quote(lua_package) .. " " .. target
end

local function build_native()
  require_executables({ "cc", "pkg-config" })
  local lua_package = os.getenv("LUA_PKG") or "lua"
  local lua_cflags = pkg_config(lua_package, "cflags")
  local lua_libs = pkg_config(lua_package, "libs")
  if lua_libs == "" then
    fail("Lua development package not found: " .. lua_package)
  end
  local flags = flag_list(lua_cflags .. " " .. lua_libs)
  build_c_shared_library("metrics.so", { "src/metrics.c", "src/lua_metrics.c" }, {
    flags = flags,
  })
end

-- The C test suites, read from tests/MANIFEST so this file, the Makefile, and
-- CMakeLists.txt cannot drift. Row format: profile | name | source ...
local function read_test_manifest()
  local path = root .. "/tests/MANIFEST"
  local suites = {}
  local handle = io.open(path, "r")
  if not handle then
    fail("Test manifest not found: " .. path)
  end
  for line in handle:lines() do
    line = line:gsub("#.*", "")
    line = line:gsub("^%s+", ""):gsub("%s+$", "")
    if line ~= "" then
      local fields = {}
      for field in line:gmatch("[^|]+") do
        table.insert(fields, trim(field))
      end
      if #fields < 3 then
        fail("Malformed manifest row: " .. line)
      end
      local sources = {}
      for source in fields[3]:gmatch("%S+") do
        table.insert(sources, source)
      end
      table.insert(suites, { profile = fields[1], name = fields[2], sources = sources })
    end
  end
  handle:close()
  return suites
end

-- profile -> compile flags and libraries. A new profile needs an entry here,
-- one in tools/tests-manifest.awk, and one in CMakeLists.txt.
local function test_profile_flags(profile, glib, gtk, stub_dir)
  if profile == "core" then
    return { flags = {}, libraries = { "-lm" } }
  elseif profile == "glib" or profile == "glib-math" then
    local libraries = {}
    for _, library in ipairs(glib.libraries) do
      table.insert(libraries, library)
    end
    if profile == "glib-math" then
      table.insert(libraries, "-lm")
    end
    return { flags = glib.flags, libraries = libraries }
  elseif profile == "gtk-stub" then
    return { flags = gtk.flags, includes = { stub_dir }, libraries = gtk.libraries }
  elseif profile == "pdftotext" then
    return {
      flags = glib.flags,
      defines = { [[PDFTOTEXT_EXECUTABLE='"pdftotext"']] },
      libraries = glib.libraries,
    }
  end
  fail("Unknown test profile: " .. profile)
end

local function build_c_tests()
  require_executables({ "cc", "awk" })
  build_c_executable("test_metrics", { "src/metrics.c", "tests/test_metrics.c" }, {
    output = root .. "/build/test_metrics",
    libraries = { "-lm" },
  })

  -- glib is the only dependency of the pure layers and the JSON codec; GTK is
  -- for the host-plumbing suites, which resolve <webview/webview.h> through
  -- the test-only stub header.
  local glib = {
    flags = flag_list(pkg_config("glib-2.0", "cflags")),
    libraries = flag_list(pkg_config("glib-2.0", "libs")),
  }
  if #glib.libraries == 0 then
    fail("GLib development package not found: pkg-config glib-2.0")
  end
  local gtk = {
    flags = flag_list(pkg_config("gtk+-3.0", "cflags")),
    libraries = flag_list(pkg_config("gtk+-3.0", "libs")),
  }
  if #gtk.libraries == 0 then
    fail("GTK 3 development package not found: pkg-config gtk+-3.0")
  end
  local stub_dir = root .. "/tests/stubs"

  for _, suite in ipairs(read_test_manifest()) do
    if suite.name ~= "metrics" then
      local profile = test_profile_flags(suite.profile, glib, gtk, stub_dir)
      build_c_executable("test_" .. suite.name, suite.sources, {
        output = root .. "/build/test_" .. suite.name,
        includes = profile.includes,
        defines = profile.defines,
        flags = profile.flags,
        libraries = profile.libraries,
      })
    end
  end
end

local function run_c_tests()
  for _, suite in ipairs(read_test_manifest()) do
    run("./build/test_" .. suite.name, root)
  end
end

local function build_all()
  build_native()
  build_desktop()
end

local function test_frontend()
  require_executables({ "npm" })
  install_frontend_dependencies()
  run("npm run check", root .. "/frontend-vue")
  run("npm test", root .. "/frontend-vue")
  run("npm run build", root .. "/frontend-vue")
end

local function test_native()
  build_c_tests()
  require_executables({ "pdftotext" })
  run_c_tests()
  require_executables({ "make" })
  run(make_command("lua-test"), root)
  run(make_command("sanitized-test"), root)
end

local function test_all()
  test_frontend()
  test_native()
end

-- The GUI smoke run needs a graphical session, so it is never part of
-- test_all(): scripts/smoke.sh drives both render modes and needs a display.
local function smoke()
  build_all()
  require_executables({ "bash" })
  run("./scripts/smoke.sh", root)
end

local function run_desktop()
  build_all()
  local app = root .. "/build/desktop/bin/metrics_desktop"
  if not file_mtime(app) then
    fail("Desktop executable was not produced: " .. app)
  end
  local render_mode = os.getenv("METRICS_RENDER_MODE") or "inline"
  print("$ METRICS_RENDER_MODE=" .. shell_quote(render_mode) .. " " .. shell_quote(app))
  local ok, reason, code = os.execute("METRICS_RENDER_MODE=" .. shell_quote(render_mode) .. " " .. shell_quote(app))
  if ok ~= true and ok ~= 0 then
    fail(string.format("Desktop application exited with status %s", tostring(type(ok) == "number" and ok or code or 1)))
  end
end

local function clean(include_dependencies)
  if include_dependencies then
    run("rm -rf " .. shell_quote(root .. "/build") .. " " .. shell_quote(root .. "/frontend-vue/node_modules"))
  else
    run("rm -rf " .. shell_quote(root .. "/build") .. " " .. shell_quote(root .. "/frontend-vue/dist"))
  end
end

local function doctor()
  local names = { "lua", "make", "cc", "c++", "cmake", "npm", "node", "pkg-config", "pdftotext", "git" }
  print("Build system: " .. root)
  for _, name in ipairs(names) do
    print(string.format("%-12s %s", name, executable_exists(name) and "found" or "missing"))
  end
  print(string.format("frontend-vue %s", file_mtime(root .. "/frontend-vue/node_modules/.bin/rsbuild") and "installed" or "not installed"))
  print(string.format("desktop artifact %s", file_mtime(root .. "/build/desktop/bin/metrics_desktop") and "present" or "missing"))
end

local commands = {
  all = build_all,
  build = build_all,
  desktop = build_desktop,
  native = build_native,
  ["c-tests"] = build_c_tests,
  frontend = function()
    require_executables({ "npm" })
    install_frontend_dependencies()
    run("npm run build", root .. "/frontend-vue")
  end,
  test = test_all,
  ["test-frontend"] = test_frontend,
  ["test-native"] = test_native,
  smoke = smoke,
  doctor = doctor,
  clean = function()
    clean(false)
  end,
  distclean = function()
    clean(true)
  end,
  rebuild = function()
    clean(false)
    build_all()
  end,
  run = run_desktop,
}

local command_name = arg[1] or "run"
if command_name == "help" or command_name == "--help" or command_name == "-h" then
  print("Usage: lua build.lua <command>")
  print("Commands: all, build, desktop, native, c-tests, frontend, test, test-frontend, test-native, smoke, doctor, clean, distclean, rebuild, run, help")
  os.exit(0)
end
local command = commands[command_name]
if not command then
  fail("Unknown command: " .. command_name .. "\nRun 'lua build.lua doctor' or 'lua build.lua help'.")
end
command()
