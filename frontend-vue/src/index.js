/*
 * Entry point: mounts the one App component and pulls in the stylesheet.
 */

import { createApp } from 'vue';
import App from './App.vue';
import './index.css';

createApp(App).mount('#root');
