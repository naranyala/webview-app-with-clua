local native = require("native.metrics")

-- Convenience API: numbers are still processed and stored by C.
local M = {}

function M.from(values)
  local engine = native.new()
  for _, value in ipairs(values) do engine:add(value) end
  return engine
end

M.new = native.new
return M
