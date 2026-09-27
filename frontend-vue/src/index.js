/*
 * Entry point: mounts the one App component and pulls in the stylesheet.
 */

import { createApp } from 'vue';
import App from './App.vue';
import './index.css';
import { runDesktopSmoke, smokeRequested } from './smoke.js';

createApp(App).mount('#root');

/*
 * A smoke run (METRICS_SMOKE=1) checks the mounted app and reports a verdict
 * through the host binding, which ends the process. Ordinary launches have no
 * marker, so this is a single boolean check away from doing nothing.
 */
if (smokeRequested()) {
  runDesktopSmoke();
}
