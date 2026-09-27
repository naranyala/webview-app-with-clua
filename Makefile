CC ?= cc
SANITIZER_CC ?= clang
LUA ?= lua
PKG_CONFIG ?= pkg-config

LUA_PKG ?= lua5.4
LUA_CFLAGS := $(shell $(PKG_CONFIG) --cflags $(LUA_PKG) 2>/dev/null || $(PKG_CONFIG) --cflags lua 2>/dev/null)
LUA_LIBS := $(shell $(PKG_CONFIG) --libs $(LUA_PKG) 2>/dev/null || $(PKG_CONFIG) --libs lua 2>/dev/null)

# app_support.c pulls in GTK for the shared path chooser; the tests link it
# but never open a dialog.
GTK_CFLAGS := $(shell $(PKG_CONFIG) --cflags gtk+-3.0 2>/dev/null)
GTK_LIBS := $(shell $(PKG_CONFIG) --libs gtk+-3.0 2>/dev/null)

CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Iinclude
LDFLAGS ?=
BUILD := build
MODULE := $(BUILD)/native/metrics.so

.PHONY: all run test core-test bridge-test workspace-test app-support-test pdf-toc-test
.PHONY: sanitized-test lua-test desktop clean check-lua check-gtk check-pdftotext

all: $(MODULE)

check-lua:
	@command -v "$(LUA)" >/dev/null 2>&1 || { echo "Lua executable '$(LUA)' not found. Set LUA=... ."; exit 1; }
	@test -n "$(LUA_LIBS)" || { echo "Lua development files not found for pkg-config package '$(LUA_PKG)'. Install the Lua development package or set LUA_PKG=... ."; exit 1; }

check-gtk:
	@test -n "$(GTK_LIBS)" || { echo "GTK 3 development files not found for pkg-config package 'gtk+-3.0'. Install the GTK 3 development package."; exit 1; }

check-pdftotext:
	@command -v pdftotext >/dev/null 2>&1 || { echo "pdftotext not found on PATH. Install Poppler (the TOC extraction tests spawn it)."; exit 1; }

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

$(BUILD)/test_workspace_store: src/workspace_store.c tests/test_workspace_store.c include/workspace_store.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -o $@ src/workspace_store.c tests/test_workspace_store.c

workspace-test: $(BUILD)/test_workspace_store
	$<

$(BUILD)/test_app_support: src/app_support.c tests/test_app_support.c include/app_support.h tests/stubs/webview/webview.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(GTK_CFLAGS) -Itests/stubs -o $@ src/app_support.c tests/test_app_support.c $(GTK_LIBS)

app-support-test: $(BUILD)/test_app_support
	$<

# Spawns pdftotext against generated fixture PDFs, so it needs Poppler on PATH.
$(BUILD)/test_pdf_toc: src/pdf_toc.c src/app_support.c tests/test_pdf_toc.c include/pdf_toc.h include/app_support.h tests/stubs/webview/webview.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(GTK_CFLAGS) -Itests/stubs -DPDFTOTEXT_EXECUTABLE='"pdftotext"' -o $@ src/pdf_toc.c src/app_support.c tests/test_pdf_toc.c $(GTK_LIBS)

pdf-toc-test: $(BUILD)/test_pdf_toc | check-pdftotext
	$<

sanitized-test:
	@mkdir -p $(BUILD)/sanitized
	$(SANITIZER_CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_metrics src/metrics.c tests/test_metrics.c -lm
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_metrics
	$(SANITIZER_CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_bridge src/metrics.c src/webview_bridge.c tests/test_bridge.c -lm
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_bridge
	@mkdir -p $(BUILD)/sanitized
	$(SANITIZER_CC) $(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_workspace_store src/workspace_store.c tests/test_workspace_store.c
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_workspace_store
	$(SANITIZER_CC) $(CFLAGS) $(GTK_CFLAGS) -Itests/stubs -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_app_support src/app_support.c tests/test_app_support.c $(GTK_LIBS)
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_app_support
	$(SANITIZER_CC) $(CFLAGS) $(GTK_CFLAGS) -Itests/stubs -DPDFTOTEXT_EXECUTABLE='"pdftotext"' -fsanitize=address,undefined -fno-omit-frame-pointer -o $(BUILD)/sanitized/test_pdf_toc src/pdf_toc.c src/app_support.c tests/test_pdf_toc.c $(GTK_LIBS)
	ASAN_OPTIONS=detect_leaks=0 $(BUILD)/sanitized/test_pdf_toc

run: $(MODULE)
	LUA_PATH='./lua/?.lua;./lua/?/init.lua;;' LUA_CPATH='./build/?.so;;' $(LUA) lua/examples/demo.lua

lua-test: $(MODULE)
	LUA_PATH='./lua/?.lua;./lua/?/init.lua;;' LUA_CPATH='./build/?.so;;' $(LUA) tests/test_core.lua

# GTK is only needed by the two host-plumbing tests.
test: check-gtk core-test bridge-test workspace-test app-support-test pdf-toc-test lua-test

# Downloads the pinned WebView dependency through CMake on first use.
desktop:
	cmake -S . -B $(BUILD)/desktop
	cmake --build $(BUILD)/desktop --target metrics_desktop
	./$(BUILD)/desktop/bin/metrics_desktop

clean:
	rm -rf $(BUILD)
