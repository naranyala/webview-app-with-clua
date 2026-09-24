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

    /* metrics_strerror should return valid strings for all error codes */
    assert(metrics_strerror(METRICS_OK) != NULL);
    assert(metrics_strerror(METRICS_ERR_NULL_ENGINE) != NULL);
    assert(metrics_strerror(METRICS_ERR_NULL_OUTPUT) != NULL);
    assert(metrics_strerror(METRICS_ERR_NON_FINITE) != NULL);
    assert(metrics_strerror(METRICS_ERR_OVERFLOW) != NULL);
    assert(metrics_strerror(METRICS_ERR_EMPTY) != NULL);
    assert(metrics_strerror(METRICS_ERR_ALLOCATION) != NULL);

    /* NULL engine handling */
    temporary = metrics_create();
    assert(temporary != NULL);
    metrics_destroy(temporary);
    metrics_destroy(NULL);
    metrics_reset(NULL);
    assert(metrics_add(NULL, 1.0) == METRICS_ERR_NULL_ENGINE);
    assert(metrics_get_summary(NULL, &result) == METRICS_ERR_NULL_ENGINE);

    engine = metrics_create();
    assert(engine != NULL);

    /* Empty engine returns METRICS_ERR_EMPTY, not NULL errors */
    assert(metrics_get_summary(engine, &result) == METRICS_ERR_EMPTY);
    assert(metrics_get_summary(engine, NULL) == METRICS_ERR_NULL_OUTPUT);

    /* Non-finite values are rejected with METRICS_ERR_NON_FINITE */
    assert(metrics_add(engine, INFINITY) == METRICS_ERR_NON_FINITE);
    assert(metrics_add(engine, -INFINITY) == METRICS_ERR_NON_FINITE);
    assert(metrics_add(engine, NAN) == METRICS_ERR_NON_FINITE);

    /* Normal computation */
    assert(metrics_add(engine, 2.0) == METRICS_OK);
    assert(metrics_add(engine, 4.0) == METRICS_OK);
    assert(metrics_add(engine, 6.0) == METRICS_OK);
    assert(metrics_get_summary(engine, &result) == METRICS_OK);
    assert(result.count == 3);
    assert_close(result.sum, 12.0, 1e-12);
    assert_close(result.mean, 4.0, 1e-12);
    assert_close(result.min, 2.0, 1e-12);
    assert_close(result.max, 6.0, 1e-12);
    assert_close(result.variance, 8.0 / 3.0, 1e-12);

    /* Reset and single value */
    metrics_reset(engine);
    assert(metrics_add(engine, -5.0) == METRICS_OK);
    assert(metrics_get_summary(engine, &result) == METRICS_OK);
    assert(result.count == 1);
    assert_close(result.sum, -5.0, 1e-12);
    assert_close(result.mean, -5.0, 1e-12);
    assert_close(result.min, -5.0, 1e-12);
    assert_close(result.max, -5.0, 1e-12);
    assert_close(result.variance, 0.0, 1e-12);

    /* Large values */
    metrics_reset(engine);
    assert(metrics_add(engine, 1000000000000.0) == METRICS_OK);
    assert(metrics_add(engine, 1000000000001.0) == METRICS_OK);
    assert(metrics_add(engine, 1000000000002.0) == METRICS_OK);
    assert(metrics_get_summary(engine, &result) == METRICS_OK);
    assert_close(result.mean, 1000000000001.0, 1e-6);
    assert_close(result.variance, 2.0 / 3.0, 1e-9);

    /* Overflow: adding DBL_MAX twice overflows */
    metrics_reset(engine);
    assert(metrics_add(engine, DBL_MAX) == METRICS_OK);
    assert(metrics_add(engine, DBL_MAX) == METRICS_ERR_OVERFLOW);
    assert(metrics_get_summary(engine, &result) == METRICS_OK);
    assert(result.count == 1);
    assert(result.sum == DBL_MAX);

    /* Negative overflow */
    metrics_reset(engine);
    assert(metrics_add(engine, -DBL_MAX) == METRICS_OK);
    assert(metrics_add(engine, -DBL_MAX) == METRICS_ERR_OVERFLOW);
    assert(metrics_get_summary(engine, &result) == METRICS_OK);
    assert(result.count == 1);
    assert(result.sum == -DBL_MAX);

    /* Empty engine after reset */
    metrics_reset(engine);
    assert(metrics_get_summary(engine, &result) == METRICS_ERR_EMPTY);

    metrics_destroy(engine);
    return 0;
}
