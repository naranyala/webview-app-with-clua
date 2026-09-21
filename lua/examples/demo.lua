local metrics = require("native.core")

local engine = metrics.from({ 12.5, 15, 8.5, 14 })
local result = engine:summary()

print(("samples=%d sum=%.1f mean=%.2f min=%.1f max=%.1f variance=%.2f")
  :format(result.count, result.sum, result.mean, result.min, result.max, result.variance))
