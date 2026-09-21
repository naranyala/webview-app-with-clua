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

metrics_engine *metrics_create(void);
void metrics_destroy(metrics_engine *engine);

/* Returns 0 on success. Non-finite values and arithmetic overflow are rejected. */
int metrics_add(metrics_engine *engine, double value);
void metrics_reset(metrics_engine *engine);
int metrics_get_summary(const metrics_engine *engine, metrics_summary *out);

#endif
