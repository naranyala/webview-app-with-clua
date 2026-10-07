/*
 * Test bootstrap, registered through `--import` in the npm test script.
 *
 * Only the `.vue` loader lives here, and that is deliberate. The jsdom window
 * is installed by the test file that needs it (see `component-dom.test.js`),
 * not globally, because installing it process-wide would silently change what
 * the other suites observe: `tests/workspace.test.js` asserts that a missing
 * `globalThis.localStorage` produces a "this browser does not allow local
 * workspace storage" report, and `tests/file-io.test.js` stubs
 * `globalThis.document` to check the anchor-download fallback. A harness that
 * gave every test a real DOM would break both -- correctly, because they are
 * testing the no-host path.
 *
 * The loader must be a preload rather than per-file setup, because a test has
 * to be able to `import App from '../src/App.vue'` at the top level.
 */
import { register } from 'node:module';

register('./sfc-loader.mjs', import.meta.url);
