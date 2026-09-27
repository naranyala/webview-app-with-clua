cmake_minimum_required(VERSION 3.16)
project(c_powered_lua_webview VERSION 0.1.0 LANGUAGES C CXX)

option(METRICS_ENABLE_DEVTOOLS "Enable WebView developer tools" ON)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

find_program(NPM_EXECUTABLE npm REQUIRED)
find_program(PDFTOTEXT_EXECUTABLE pdftotext REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GTK REQUIRED IMPORTED_TARGET gtk+-3.0)

include(FetchContent)
FetchContent_Declare(
  webview
  GIT_REPOSITORY https://github.com/webview/webview.git
  GIT_TAG 0.12.0
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(webview)

add_executable(metrics_desktop
  src/webview_app.c
  src/json_io.c
  src/app_support.c
  src/pdf_toc.c
  src/pdf_session.c
  src/image_directory.c
  src/outline_pdf.c
  src/smoke.c
  src/workspace_bindings.c
  src/text_transfer.c
  src/webview_bridge.c
  src/workspace_store.c
  src/metrics.c
)

# --- C test suites -----------------------------------------------------------
#
# Read from tests/MANIFEST, the same file the Makefile and build.lua read, so
# `ctest` and `make test` run the same set. Add a suite in one place.
#
# profile -> flags. A new profile needs an entry here, one in
# tools/tests-manifest.awk, and one in build.lua's test_profile_flags.
include(CTest)
file(STRINGS "${CMAKE_CURRENT_SOURCE_DIR}/tests/MANIFEST" manifest_lines)
pkg_check_modules(GLIB REQUIRED IMPORTED_TARGET glib-2.0)
# Cairo writes the combined-outline PDF. It is already present transitively via
# gtk+-3.0, but it is named explicitly so the profile is honest about the need.
pkg_check_modules(CAIRO REQUIRED IMPORTED_TARGET cairo)
set(CMAKE_PROFILE_core "")
set(CMAKE_PROFILE_glib "PkgConfig::GLIB")
set(CMAKE_PROFILE_glib-math "PkgConfig::GLIB")
set(CMAKE_PROFILE_gtk-stub "PkgConfig::GTK")
set(CMAKE_PROFILE_pdftotext "PkgConfig::GLIB")
# GTK because the suite links app_support.c for the shared chooser; m for lround.
set(CMAKE_PROFILE_cairo "PkgConfig::CAIRO;PkgConfig::GTK;m")

foreach (line IN LISTS manifest_lines)
  string(REGEX REPLACE "#.*" "" line "${line}")
  string(STRIP "${line}" line)
  if (NOT "${line}" STREQUAL "")
    # Strip the padding around the pipes before splitting, so a field is never
    # " core" and a target is never named "test_ core".
    string(REGEX REPLACE "[ \t]*\\|[ \t]*" "|" line "${line}")
    string(REPLACE "|" ";" fields "${line}")
    list(LENGTH fields field_count)
    if (field_count LESS 3)
      continue()
    endif()
    list(GET fields 0 profile)
    list(GET fields 1 suite)
    list(LENGTH fields field_count)
    # The third field is a space-separated source list, so split it too.
    set(sources "")
    math(EXPR last "${field_count} - 1")
    foreach (index RANGE 2 ${last})
      list(GET fields ${index} group)
      string(REPLACE " " ";" group "${group}")
      list(APPEND sources ${group})
    endforeach()

    set(target "test_${suite}")
    add_executable(${target} ${sources})
    target_include_directories(${target} PRIVATE include)
    target_link_libraries(${target} PRIVATE ${CMAKE_PROFILE_${profile}})
    if (profile STREQUAL "core")
      target_link_libraries(${target} PRIVATE m)
    endif()
    if (profile STREQUAL "pdftotext")
      target_compile_definitions(${target} PRIVATE PDFTOTEXT_EXECUTABLE="pdftotext")
    endif()
    if (profile STREQUAL "gtk-stub" OR profile STREQUAL "cairo")
      target_include_directories(${target} PRIVATE tests/stubs)
    endif()
    # The suites write fixtures under build/<suite>-test, so they must run from
    # the source root exactly as they do under make and build.lua.
    add_test(NAME ${suite} COMMAND ${target} WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
  endif()
endforeach()

target_include_directories(metrics_desktop PRIVATE include)
target_link_libraries(metrics_desktop PRIVATE webview::core_static PkgConfig::GTK PkgConfig::CAIRO)
set(FRONTEND_DIR "${CMAKE_CURRENT_SOURCE_DIR}/frontend-vue")
set(FRONTEND_HTML "${FRONTEND_DIR}/dist/index.html")
set(FRONTEND_SOURCES
  "${FRONTEND_DIR}/src/index.js"
  "${FRONTEND_DIR}/src/App.vue"
  "${FRONTEND_DIR}/src/index.css"
  "${FRONTEND_DIR}/src/image-viewer.js"
  "${FRONTEND_DIR}/src/pdf-compat.js"
  "${FRONTEND_DIR}/src/workspace.js"
  "${FRONTEND_DIR}/src/workspace-report.js"
  "${FRONTEND_DIR}/src/native-bridge.js"
  "${FRONTEND_DIR}/src/boot-state.js"
  "${FRONTEND_DIR}/src/app-shell.js"
  "${FRONTEND_DIR}/src/editor-session.js"
  "${FRONTEND_DIR}/src/pdf-session.js"
  "${FRONTEND_DIR}/src/image-session.js"
  "${FRONTEND_DIR}/src/map-explorer.js"
  "${FRONTEND_DIR}/src/outline-pdf.js"
  "${FRONTEND_DIR}/src/toc-outline.js"
  "${FRONTEND_DIR}/public/index.html"
  "${FRONTEND_DIR}/rsbuild.config.js"
  "${FRONTEND_DIR}/plugins/single-file-html.js"
  "${FRONTEND_DIR}/tests/image-viewer.test.js"
  "${FRONTEND_DIR}/tests/static-shell.test.js"
  "${FRONTEND_DIR}/tests/workspace.test.js"
  "${FRONTEND_DIR}/tests/map-explorer.test.js"
  "${FRONTEND_DIR}/tests/outline-pdf.test.js"
  "${FRONTEND_DIR}/tests/template-bindings.test.js"
  "${FRONTEND_DIR}/tests/native-bridge.test.js"
  "${FRONTEND_DIR}/tests/workspace-report.test.js"
  "${FRONTEND_DIR}/tests/app-shell.test.js"
  "${FRONTEND_DIR}/tests/editor-session.test.js"
  "${FRONTEND_DIR}/tests/pdf-session.test.js"
  "${FRONTEND_DIR}/tests/image-session.test.js"
  "${FRONTEND_DIR}/tests/toc-outline.test.js"
  "${FRONTEND_DIR}/package.json"
  "${FRONTEND_DIR}/package-lock.json"
)

target_compile_definitions(metrics_desktop PRIVATE
  APP_HTML_PATH="${FRONTEND_HTML}"
  PDFTOTEXT_EXECUTABLE="${PDFTOTEXT_EXECUTABLE}"
  METRICS_ENABLE_DEVTOOLS=$<BOOL:${METRICS_ENABLE_DEVTOOLS}>
)

# Treat the generated HTML as a real build output so repeated desktop builds
# reuse the existing frontend bundle when its inputs have not changed.
add_custom_command(
  OUTPUT "${FRONTEND_HTML}"
  COMMAND ${NPM_EXECUTABLE} run build
  WORKING_DIRECTORY "${FRONTEND_DIR}"
  DEPENDS ${FRONTEND_SOURCES}
  COMMENT "Building the standalone WebView frontend"
  VERBATIM
)
add_custom_target(frontend_build DEPENDS "${FRONTEND_HTML}")
add_dependencies(metrics_desktop frontend_build)

if(UNIX AND NOT APPLE)
  target_link_libraries(metrics_desktop PRIVATE m)
endif()
