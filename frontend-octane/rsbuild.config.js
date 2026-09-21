// @ts-check

import { pluginOctane } from '@octanejs/rsbuild-plugin';
import { defineConfig } from '@rsbuild/core';
import { pluginTailwindcss } from '@rsbuild/plugin-tailwindcss';
import { pluginSingleFileHtml } from './plugins/single-file-html.js';

// Docs: https://rsbuild.rs/config/
export default defineConfig({
  plugins: [pluginOctane(), pluginTailwindcss(), pluginSingleFileHtml()],
  output: {
    inlineScripts: true,
    inlineStyles: true,
  },
  performance: {
    chunkSplit: {
      strategy: 'all-in-one',
    },
  },
  server: {
    // A desktop build has no asset server; the final HTML is fully self-contained.
    publicDir: false,
  },
});
