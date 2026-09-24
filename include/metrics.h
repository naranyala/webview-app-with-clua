#ifndef METRICS_H
#define METRICS_H

#include <stddef.h>

typedef struct metrics_engine metrics_engine;

typedef struct {
    size_t count;
    double sum;
    double min;
    double max;
    double mean;
    double variance; /* population variance (M2 / count) */
} metrics_summary;

typedef enum {
    METRICS_OK = 0,
    METRICS_ERR_NULL_ENGINE = -1,
    METRICS_ERR_NULL_OUTPUT = -2,
    METRICS_ERR_NON_FINITE = -3,
    METRICS_ERR_OVERFLOW = -4,
    METRICS_ERR_EMPTY = -5,
    METRICS_ERR_ALLOCATION = -6,
} metrics_error;

metrics_engine *metrics_create(void);
void metrics_destroy(metrics_engine *engine);

/* Returns METRICS_OK on success, or a negative metrics_error code. */
metrics_error metrics_add(metrics_engine *engine, double value);
void metrics_reset(metrics_engine *engine);
metrics_error metrics_get_summary(const metrics_engine *engine, metrics_summary *out);

/* Returns a human-readable string for a metrics_error code. */
const char *metrics_strerror(metrics_error error);

#endif
