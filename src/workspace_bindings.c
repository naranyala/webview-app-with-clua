/*
 * loadWorkspace / saveWorkspace bindings for the durable JSON store.
 *
 * See include/workspace_bindings.h for the layer contract. Reads and writes
 * go through workspace_store.c, which enforces the 4 MiB cap and writes
 * atomically; every failure is reported with the shared error shape so the
 * frontend can show a workspace report instead of losing work silently.
 */

#include "workspace_bindings.h"

#include "workspace_store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Absolute path of the durable workspace file under $XDG_DATA_HOME. */
static char *workspace_file_path(void) {
    return g_build_filename(g_get_user_data_dir(), "native-workspace", "workspace.json", NULL);
}

/* Creates $XDG_DATA_HOME/native-workspace when it does not exist yet. */
static int ensure_workspace_directory(void) {
    char *directory = g_build_filename(g_get_user_data_dir(), "native-workspace", NULL);
    int created = g_mkdir_with_parents(directory, 0700) == 0;
    g_free(directory);
    return created;
}

/*
 * Rejects a workspace request with the shared error shape. Codes and messages
 * mirror docs/bridge-protocol.md because the frontend keys its report off them.
 */
static void return_workspace_error(webview_t view, const char *id, const char *code, const char *message) {
    GString *response = g_string_new("{\"error\":{\"code\":\"");
    g_string_append(response, code);
    g_string_append(response, "\",\"message\":\"");
    g_string_append(response, message);
    g_string_append(response, "\"}}");
    webview_return(view, id, 1, response->str);
    g_string_free(response, TRUE);
}

/*
 * Answers {"ok":true,"workspace":<doc>}. Three outcomes are distinguished on
 * purpose: an empty file is a first run (workspace:null), a read failure
 * rejects with READ_FAILED, and bytes that are not a JSON object reject with
 * INVALID_CONTENT so a damaged file is reported rather than ignored.
 */
void on_load_workspace(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    workspace_store_result store_result = WORKSPACE_STORE_OK;
    size_t length = 0;
    char *path;
    char *data;
    GString *response;

    (void)request;

    path = workspace_file_path();
    if (path == NULL) {
        return_workspace_error(app->view, id, "INTERNAL_ERROR", "The workspace location could not be determined.");
        return;
    }
    data = workspace_store_load(path, &length, &store_result);
    g_free(path);
    if (data == NULL) {
        return_workspace_error(app->view, id, "READ_FAILED", workspace_store_strerror(store_result));
        return;
    }

    if (length > 0 && !workspace_store_is_object(data, length)) {
        fprintf(stderr, "loadWorkspace: stored workspace is not a JSON object, reporting INVALID_CONTENT\n");
        free(data);
        return_workspace_error(app->view, id, "INVALID_CONTENT",
            "The saved workspace file is damaged and cannot be restored.");
        return;
    }

    fprintf(stderr, "loadWorkspace: %zu bytes from disk\n", length);

    response = g_string_new("{\"ok\":true,\"workspace\":");
    if (length > 0) {
        g_string_append_len(response, data, (gssize)length);
    } else {
        g_string_append(response, "null");
    }
    g_string_append_c(response, '}');
    webview_return(app->view, id, 0, response->str);
    g_string_free(response, TRUE);
    free(data);
}

/*
 * Validates the JSON payload, creates the store directory, and hands the bytes
 * to workspace_store_save() for an atomic replace.
 */
void on_save_workspace(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    workspace_store_result store_result = WORKSPACE_STORE_OK;
    char *payload;
    char *path;
    size_t length;

    payload = workspace_store_decode_argument(request, &store_result);
    if (payload == NULL) {
        return_workspace_error(app->view, id, "INVALID_ARGUMENT", workspace_store_strerror(store_result));
        return;
    }

    length = strlen(payload);
    if (!workspace_store_is_object(payload, length)) {
        free(payload);
        return_workspace_error(app->view, id, "INVALID_PAYLOAD", "The workspace payload must be a JSON object.");
        return;
    }
    if (!ensure_workspace_directory()) {
        free(payload);
        return_workspace_error(app->view, id, "WRITE_FAILED", workspace_store_strerror(WORKSPACE_STORE_ERR_WRITE));
        return;
    }

    path = workspace_file_path();
    if (path == NULL) {
        free(payload);
        return_workspace_error(app->view, id, "INTERNAL_ERROR", "The workspace location could not be determined.");
        return;
    }
    store_result = workspace_store_save(path, payload, length);
    g_free(path);
    if (store_result != WORKSPACE_STORE_OK) {
        free(payload);
        return_workspace_error(app->view, id,
                               store_result == WORKSPACE_STORE_ERR_TOO_LARGE ? "PAYLOAD_TOO_LARGE" : "WRITE_FAILED",
                               workspace_store_strerror(store_result));
        return;
    }

    fprintf(stderr, "saveWorkspace: %zu bytes written to disk\n", length);
    webview_return(app->view, id, 0, "{\"ok\":true}");
    free(payload);
}
