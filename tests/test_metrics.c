#include "metrics.h"

#include <assert.h>
#include <float.h>
#include <math.h>

static void assert_close(double actual, double expected, double tolerance) {
    assert(fabs(actual - expected) <= tolerance);
}

int main(void) {
    metrics_engine *engine;
    metrics_engine *temporary;
    metrics_summary result;

    temporary = metrics_create();
    assert(temporary != NULL);
    metrics_destroy(temporary);
    metrics_destroy(NULL);
    metrics_reset(NULL);
    assert(metrics_add(NULL, 1.0) != 0);
    assert(metrics_get_summary(NULL, &result) != 0);

    engine = metrics_create();
    assert(engine != NULL);
    assert(metrics_get_summary(engine, &result) != 0);
    assert(metrics_get_summary(engine, NULL) != 0);
    assert(metrics_add(engine, INFINITY) != 0);
    assert(metrics_add(engine, -INFINITY) != 0);
    assert(metrics_add(engine, NAN) != 0);

    assert(metrics_add(engine, 2.0) == 0);
    assert(metrics_add(engine, 4.0) == 0);
    assert(metrics_add(engine, 6.0) == 0);
    assert(metrics_get_summary(engine, &result) == 0);
    assert(result.count == 3);
    assert_close(result.sum, 12.0, 1e-12);
    assert_close(result.mean, 4.0, 1e-12);
    assert_close(result.min, 2.0, 1e-12);
    assert_close(result.max, 6.0, 1e-12);
    assert_close(result.variance, 8.0 / 3.0, 1e-12);

    metrics_reset(engine);
    assert(metrics_add(engine, -5.0) == 0);
    assert(metrics_get_summary(engine, &result) == 0);
    assert(result.count == 1);
    assert_close(result.sum, -5.0, 1e-12);
    assert_close(result.mean, -5.0, 1e-12);
    assert_close(result.min, -5.0, 1e-12);
    assert_close(result.max, -5.0, 1e-12);
    assert_close(result.variance, 0.0, 1e-12);

    metrics_reset(engine);
    assert(metrics_add(engine, 1000000000000.0) == 0);
    assert(metrics_add(engine, 1000000000001.0) == 0);
    assert(metrics_add(engine, 1000000000002.0) == 0);
    assert(metrics_get_summary(engine, &result) == 0);
    assert_close(result.mean, 1000000000001.0, 1e-6);
    assert_close(result.variance, 2.0 / 3.0, 1e-9);

    metrics_reset(engine);
    assert(metrics_add(engine, DBL_MAX) == 0);
    assert(metrics_add(engine, DBL_MAX) != 0);
    assert(metrics_get_summary(engine, &result) == 0);
    assert(result.count == 1);
    assert(result.sum == DBL_MAX);

    metrics_reset(engine);
    assert(metrics_add(engine, -DBL_MAX) == 0);
    assert(metrics_add(engine, -DBL_MAX) != 0);
    assert(metrics_get_summary(engine, &result) == 0);
    assert(result.count == 1);
    assert(result.sum == -DBL_MAX);

    metrics_reset(engine);
    assert(metrics_get_summary(engine, &result) != 0);
    metrics_destroy(engine);
    return 0;
}
