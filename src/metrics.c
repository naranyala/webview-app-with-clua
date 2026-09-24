#include "metrics.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>

struct metrics_engine {
    size_t count;
    double sum;
    double mean;
    double m2;
    double min;
    double max;
};

metrics_engine *metrics_create(void) {
    return calloc(1, sizeof(metrics_engine));
}

void metrics_destroy(metrics_engine *engine) {
    free(engine);
}

metrics_error metrics_add(metrics_engine *engine, double value) {
    size_t next_count;
    double next_sum;
    double next_mean;
    double next_m2;
    double delta;

    if (engine == NULL) return METRICS_ERR_NULL_ENGINE;
    if (!isfinite(value)) return METRICS_ERR_NON_FINITE;

    if (engine->count == SIZE_MAX) return METRICS_ERR_OVERFLOW;
    next_count = engine->count + 1;
    next_sum = engine->sum + value;
    if (!isfinite(next_sum)) return METRICS_ERR_OVERFLOW;

    if (engine->count == 0) {
        next_mean = value;
        next_m2 = 0.0;
    } else {
        delta = value - engine->mean;
        next_mean = engine->mean + delta / (double)next_count;
        next_m2 = engine->m2 + delta * (value - next_mean);
        if (!isfinite(next_mean) || !isfinite(next_m2)) return METRICS_ERR_OVERFLOW;
        if (next_m2 < 0.0 && next_m2 > -1e-12) next_m2 = 0.0;
    }

    if (engine->count == 0) engine->min = engine->max = value;
    if (value < engine->min) engine->min = value;
    if (value > engine->max) engine->max = value;
    engine->count = next_count;
    engine->sum = next_sum;
    engine->mean = next_mean;
    engine->m2 = next_m2;
    return METRICS_OK;
}

void metrics_reset(metrics_engine *engine) {
    if (engine != NULL) {
        engine->count = 0;
        engine->sum = 0.0;
        engine->mean = 0.0;
        engine->m2 = 0.0;
        engine->min = 0.0;
        engine->max = 0.0;
    }
}

metrics_error metrics_get_summary(const metrics_engine *engine, metrics_summary *out) {
    if (engine == NULL) return METRICS_ERR_NULL_ENGINE;
    if (out == NULL) return METRICS_ERR_NULL_OUTPUT;
    if (engine->count == 0) return METRICS_ERR_EMPTY;
    out->count = engine->count;
    out->sum = engine->sum;
    out->min = engine->min;
    out->max = engine->max;
    out->mean = engine->mean;
    out->variance = engine->m2 / (double)engine->count;
    return METRICS_OK;
}

const char *metrics_strerror(metrics_error error) {
    switch (error) {
        case METRICS_OK:              return "success";
        case METRICS_ERR_NULL_ENGINE: return "metrics engine pointer is NULL";
        case METRICS_ERR_NULL_OUTPUT: return "output pointer is NULL";
        case METRICS_ERR_NON_FINITE:  return "value is not finite (NaN or infinity)";
        case METRICS_ERR_OVERFLOW:    return "arithmetic overflow during computation";
        case METRICS_ERR_EMPTY:       return "no values have been added to the engine";
        case METRICS_ERR_ALLOCATION:  return "memory allocation failed";
    }
    return "unknown error";
}
