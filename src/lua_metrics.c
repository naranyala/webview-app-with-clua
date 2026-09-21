#include "metrics.h"

#include <lua.h>
#include <lauxlib.h>

#define METRICS_MT "native.core.metrics"

typedef struct { metrics_engine *engine; } lua_metrics;

static lua_metrics *check_engine(lua_State *L) {
    return luaL_checkudata(L, 1, METRICS_MT);
}

static int l_new(lua_State *L) {
    lua_metrics *handle = lua_newuserdata(L, sizeof(*handle));
    handle->engine = metrics_create();
    if (handle->engine == NULL) return luaL_error(L, "could not allocate metrics engine");
    luaL_setmetatable(L, METRICS_MT);
    return 1;
}

static int l_add(lua_State *L) {
    lua_metrics *handle = check_engine(L);
    double value = luaL_checknumber(L, 2);
    if (metrics_add(handle->engine, value) != 0) return luaL_error(L, "value must be finite");
    lua_settop(L, 1);
    return 1;
}

static int l_summary(lua_State *L) {
    lua_metrics *handle = check_engine(L);
    metrics_summary s;
    if (metrics_get_summary(handle->engine, &s) != 0) return luaL_error(L, "cannot summarize an empty engine");
    lua_createtable(L, 0, 6);
    lua_pushinteger(L, (lua_Integer)s.count); lua_setfield(L, -2, "count");
    lua_pushnumber(L, s.sum); lua_setfield(L, -2, "sum");
    lua_pushnumber(L, s.min); lua_setfield(L, -2, "min");
    lua_pushnumber(L, s.max); lua_setfield(L, -2, "max");
    lua_pushnumber(L, s.mean); lua_setfield(L, -2, "mean");
    lua_pushnumber(L, s.variance); lua_setfield(L, -2, "variance");
    return 1;
}

static int l_reset(lua_State *L) { metrics_reset(check_engine(L)->engine); return 0; }
static int l_gc(lua_State *L) { lua_metrics *h = check_engine(L); metrics_destroy(h->engine); h->engine = NULL; return 0; }

int luaopen_native_metrics(lua_State *L) {
    static const luaL_Reg methods[] = {
        {"add", l_add}, {"summary", l_summary}, {"reset", l_reset}, {NULL, NULL}
    };
    luaL_newmetatable(L, METRICS_MT);
    lua_pushcfunction(L, l_gc); lua_setfield(L, -2, "__gc");
    lua_newtable(L); luaL_setfuncs(L, methods, 0); lua_setfield(L, -2, "__index");
    lua_pop(L, 1);
    lua_newtable(L);
    lua_pushcfunction(L, l_new); lua_setfield(L, -2, "new");
    return 1;
}
