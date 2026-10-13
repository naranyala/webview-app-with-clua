/*
 * Lua bindings for metrics_engine, exposed as `require("native.metrics")`
 * (the convenience wrapper in lua/native/core.lua re-exports it as
 * `require("native.core")`).
 *
 * Each engine is a full userdata holding the metrics_engine pointer; __gc
 * destroys it, so scripts cannot leak one, and the metatable is locked with
 * __metatable so scripts cannot replace __gc either. Every C failure becomes
 * a distinct Lua error naming its own cause: a destroyed handle never reports
 * as "empty", and an overflow never reports as "non-finite".
 */

#include "metrics.h"

#include <lua.h>
#include <lauxlib.h>

#define METRICS_MT "native.core.metrics"

typedef struct { metrics_engine *engine; } lua_metrics;

static lua_metrics *check_engine(lua_State *L) {
    return luaL_checkudata(L, 1, METRICS_MT);
}

/* The live engine or a "destroyed" raise: a collected handle must never
 * report as empty, overflowing, or non-finite. */
static metrics_engine *check_live_engine(lua_State *L) {
    lua_metrics *handle = check_engine(L);
    if (handle->engine == NULL) luaL_error(L, "metrics engine is destroyed");
    return handle->engine;
}

static int l_new(lua_State *L) {
    lua_metrics *handle = lua_newuserdata(L, sizeof(*handle));
    handle->engine = metrics_create();
    if (handle->engine == NULL) return luaL_error(L, "could not allocate metrics engine");
    luaL_setmetatable(L, METRICS_MT);
    return 1;
}

static int l_add(lua_State *L) {
    metrics_engine *engine = check_live_engine(L);
    metrics_error status;
    /* luaL_checknumber coerces numeric strings; the C API takes doubles, so
     * a string is a caller bug rather than a value. */
    if (lua_type(L, 2) != LUA_TNUMBER) return luaL_argerror(L, 2, "number expected");
    status = metrics_add(engine, lua_tonumber(L, 2));
    if (status == METRICS_ERR_NON_FINITE) return luaL_error(L, "value must be finite");
    if (status == METRICS_ERR_OVERFLOW) return luaL_error(L, "value overflows the running totals");
    if (status != METRICS_OK) return luaL_error(L, "could not add value (%s)", metrics_strerror(status));
    lua_settop(L, 1);
    return 1;
}

static int l_summary(lua_State *L) {
    metrics_engine *engine = check_live_engine(L);
    metrics_summary s;
    metrics_error status = metrics_get_summary(engine, &s);
    if (status == METRICS_ERR_EMPTY) return luaL_error(L, "cannot summarize an empty engine");
    if (status != METRICS_OK) return luaL_error(L, "could not summarize (%s)", metrics_strerror(status));
    lua_createtable(L, 0, 6);
    lua_pushinteger(L, (lua_Integer)s.count); lua_setfield(L, -2, "count");
    lua_pushnumber(L, s.sum); lua_setfield(L, -2, "sum");
    lua_pushnumber(L, s.min); lua_setfield(L, -2, "min");
    lua_pushnumber(L, s.max); lua_setfield(L, -2, "max");
    lua_pushnumber(L, s.mean); lua_setfield(L, -2, "mean");
    lua_pushnumber(L, s.variance); lua_setfield(L, -2, "variance");
    return 1;
}

static int l_reset(lua_State *L) { metrics_reset(check_live_engine(L)); return 0; }
static int l_gc(lua_State *L) { lua_metrics *h = check_engine(L); metrics_destroy(h->engine); h->engine = NULL; return 0; }

int luaopen_native_metrics(lua_State *L) {
    static const luaL_Reg methods[] = {
        {"add", l_add}, {"summary", l_summary}, {"reset", l_reset}, {NULL, NULL}
    };
    luaL_newmetatable(L, METRICS_MT);
    lua_pushcfunction(L, l_gc); lua_setfield(L, -2, "__gc");
    lua_newtable(L); luaL_setfuncs(L, methods, 0); lua_setfield(L, -2, "__index");
    /* Locked: getmetatable() returns this string instead of the table, so a
     * script can neither replace __gc (leaking the engine) nor call it. */
    lua_pushstring(L, "metrics engine metatable is locked"); lua_setfield(L, -2, "__metatable");
    lua_pop(L, 1);
    lua_newtable(L);
    lua_pushcfunction(L, l_new); lua_setfield(L, -2, "new");
    return 1;
}
