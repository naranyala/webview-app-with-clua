cmake_minimum_required(VERSION 3.16)
project(c_powered_lua_webview VERSION 0.1.0 LANGUAGES C CXX)

option(METRICS_ENABLE_DEVTOOLS "Enable WebView developer tools" ON)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

find_program(NPM_EXECUTABLE npm REQUIRED)

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
  src/webview_bridge.c
  src/metrics.c
)

target_include_directories(metrics_desktop PRIVATE include)
target_link_libraries(metrics_desktop PRIVATE webview::core_static)
set(FRONTEND_DIR "${CMAKE_CURRENT_SOURCE_DIR}/frontend-octane")
set(FRONTEND_HTML "${FRONTEND_DIR}/dist/index.html")
set(FRONTEND_SOURCES
  "${FRONTEND_DIR}/src/index.js"
  "${FRONTEND_DIR}/src/App.tsrx"
  "${FRONTEND_DIR}/src/App.css"
  "${FRONTEND_DIR}/public/index.html"
  "${FRONTEND_DIR}/rsbuild.config.js"
  "${FRONTEND_DIR}/plugins/single-file-html.js"
  "${FRONTEND_DIR}/package.json"
  "${FRONTEND_DIR}/package-lock.json"
)

target_compile_definitions(metrics_desktop PRIVATE
  APP_HTML_PATH="${FRONTEND_HTML}"
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
