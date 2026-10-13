local native = require("native.metrics")

-- Convenience API: numbers are still processed and stored by C.
local M = {}

function M.from(values)
  assert(type(values) == "table", "from() expects a table of numbers")
  local engine = native.new()
  -- ipairs stops at the first hole, so a nil would silently drop the tail;
  -- the type check names the position instead of losing data quietly.
  for index, value in ipairs(values) do
    assert(type(value) == "number", ("from(): value #%d is not a number"):format(index))
    engine:add(value)
  end
  return engine
end

M.new = native.new
return M
