CC ?= cc
SANITIZER_CC ?= clang
LUA ?= lua
PKG_CONFIG ?= pkg-config

LUA_PKG ?= lua5.4
LUA_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(LUA_PKG) 2>/dev/null || $(PKG_CONFIG) --cflags lua 2>/dev/null)
LUA_LIBS := $(shell $(PKG_CONFIG) --libs $(LUA_PKG) 2>/dev/null || $(PKG_CONFIG) --libs lua 2>/dev/null)

CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Iinclude
LDFLAGS ?=
BUILD := build
MODULE := $(BUILD)/native/metrics.so

.PHONY: all run test core-test bridge-test sanitized-test lua-test desktop clean check-lua

all: $(MODULE)

check-lua:
	@command -v "$(LUA)" >/dev/null 2>&1 || { echo "Lua executable '$(LUA)' not found. Set LUA=... ."; exit 1; }
	@test -n "$(LUA_CFLAGS)" && test -n "$(LUA_LIBS)" || { echo "Lua development files not found for pkg-config package '$(LUA_PKG)'. Install the Lua development package or set LUA_PKG=... ."; exit 1; }

$(MODULE): src/metrics.c src/lua_metrics.c include/metrics.h | check-lua
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(LUA_CFLAGS) -fPIC -shared -o $@ src/metrics.c src/lua_metrics.c $(LUA_LIBS) $(LDFLAGS)

$(BUILD)/test_metrics: src/metrics.c tests/test_metrics.c include/metrics.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -o $@ src/metrics.c tests/test_metrics.c -lm

core-test: $(BUILD)/test_metrics
	$<

$(BUILD)/test_bridge: src/metrics.c src/webview_bridge.c tests/test_bridge.c include/metrics.h include/webview_bridge.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -o $@ src/metrics.c src/webview_bridge.c tests/test_bridge.c -lm

bridge-test: $(BUILD)/test_bridge
	$<

sanitized-test:
	@mkdir -p $(BUILD)/sanitized
	$(SANITIZER_CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_metrics src/metrics.c tests/test_metrics.c -lm
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_metrics
	$(SANITIZER_CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_bridge src/metrics.c src/webview_bridge.c tests/test_bridge.c -lm
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_bridge

run: $(MODULE)
	LUA_PATH='./lua/?.lua;./lua/?/init.lua;;' LUA_CPATH='./build/?.so;;' $(LUA) lua/examples/demo.lua

lua-test: $(MODULE)
	LUA_PATH='./lua/?.lua;./lua/?/init.lua;;' LUA_CPATH='./build/?.so;;' $(LUA) tests/test_core.lua

test: core-test bridge-test lua-test

# Downloads the pinned WebView dependency through CMake on first use.
desktop:
	cmake -S . -B $(BUILD)/desktop
	cmake --build $(BUILD)/desktop --target metrics_desktop
	./$(BUILD)/desktop/bin/metrics_desktop

clean:
	rm -rf $(BUILD)
