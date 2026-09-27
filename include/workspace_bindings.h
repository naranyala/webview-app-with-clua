#ifndef WORKSPACE_BINDINGS_H
#define WORKSPACE_BINDINGS_H

/*
 * Workspace persistence bindings (layer 3: UI plumbing).
 *
 * loadWorkspace/saveWorkspace expose the durable JSON store under
 * $XDG_DATA_HOME/native-workspace/workspace.json to the frontend. The store
 * itself (size cap, atomic replace, validation) lives in workspace_store.c;
 * this file only marshals arguments and answers with the shared error shape,
 * including INVALID_CONTENT when the stored bytes are not a JSON object so
 * the UI can report a damaged file instead of silently starting empty.
 *
 * Both functions match the webview_bind callback signature for main().
 */

#include "app_support.h"

/* Binds "loadWorkspace": resolves {"ok":true,"workspace":<doc>|null}. */
void on_load_workspace(const char *id, const char *request, void *argument);

/* Binds "saveWorkspace": resolves {"ok":true} after an atomic write. */
void on_save_workspace(const char *id, const char *request, void *argument);

#endif /* WORKSPACE_BINDINGS_H */
