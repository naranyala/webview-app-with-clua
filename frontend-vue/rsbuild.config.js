// @ts-check
import { defineConfig } from '@rsbuild/core';
import { pluginVue } from '@rsbuild/plugin-vue';
import { pluginSingleFileHtml } from './plugins/single-file-html.js';

export default defineConfig({
  plugins: [pluginVue(), pluginSingleFileHtml()],
  output: {
    inlineScripts: true,
    inlineStyles: true,
  },
  html: {
    template: './public/index.html',
    inject: 'body',
    scriptLoading: 'blocking',
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one',
    },
  },
  server: {
    publicDir: false,
  },
});
