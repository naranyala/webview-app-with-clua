-- Binding test for the Lua metrics module (native.core), driven by lua-test
-- in the Makefile. It mirrors the C unit tests: creation, rejected input, and
-- the summary snapshot handed back across the Lua boundary.

local metrics = require("native.core")
local engine = metrics.from({ 1, 3, 5 })
local summary = engine:summary()

assert(summary.count == 3)
assert(summary.sum == 9)
assert(summary.mean == 3)
assert(summary.min == 1 and summary.max == 5)
assert(summary.variance == 8 / 3)
assert(engine:add(-1) == engine)
summary = engine:summary()
assert(summary.count == 4 and summary.min == -1)
assert(not pcall(function() engine:add(0 / 0) end))
assert(not pcall(function() engine:add(math.huge) end))
engine:reset()
assert(not pcall(function() engine:summary() end))

local singleton = metrics.from({ -42 })
summary = singleton:summary()
assert(summary.count == 1)
assert(summary.mean == -42 and summary.min == -42 and summary.max == -42)
assert(summary.variance == 0)

-- Overflow is its own error, not "must be finite".
local big = metrics.new()
big:add(1e308)
local overflowed, overflow_err = true, ""
for _ = 1, 4 do
  overflowed, overflow_err = pcall(function() big:add(1e308) end)
  if not overflowed then break end
end
assert(not overflowed and string.find(overflow_err, "overflow"))

-- Strings are rejected, not coerced: the C API takes doubles.
local string_ok, string_err = pcall(function() engine:add("3.5") end)
assert(not string_ok and string.find(string_err, "number expected"))

-- from() names the position instead of dropping data quietly.
assert(not pcall(function() metrics.from(nil) end))
local hole_ok, hole_err = pcall(function() metrics.from({ 1, "2", 3 }) end)
assert(not hole_ok and string.find(hole_err, "#2"))

-- The metatable is locked: __gc can neither be replaced nor called.
assert(type(getmetatable(engine)) == "string")

-- A destroyed handle reports itself instead of "empty" or "finite".
local doomed = metrics.new()
doomed:add(5)
debug.getmetatable(doomed).__gc(doomed)
local dead_ok, dead_err = pcall(function() doomed:add(1) end)
assert(not dead_ok and string.find(dead_err, "destroyed"))
local dead_ok2, dead_err2 = pcall(function() doomed:summary() end)
assert(not dead_ok2 and string.find(dead_err2, "destroyed"))
local dead_ok3, dead_err3 = pcall(function() doomed:reset() end)
assert(not dead_ok3 and string.find(dead_err3, "destroyed"))
print("Lua integration tests passed")
