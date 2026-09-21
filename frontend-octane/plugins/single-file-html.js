import { readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Leaves each Rsbuild output directory with only its generated HTML file.
 * `output.inlineScripts` and `output.inlineStyles` must be enabled as well.
 */
export function pluginSingleFileHtml() {
  return {
    name: 'single-file-html',
    apply: 'build',
    setup(api) {
      api.onAfterBuild(async ({ environments }) => {
        await Promise.all(
          Object.values(environments).map(async (environment) => {
            const htmlFiles = new Set(Object.values(environment.htmlPaths));
            const entries = await readdir(environment.distPath, {
              withFileTypes: true,
            });

            await Promise.all(
              entries.map(async (entry) => {
                const relativePath = relative(
                  environment.distPath,
                  join(environment.distPath, entry.name),
                );
                if (!htmlFiles.has(relativePath)) {
                  await rm(join(environment.distPath, entry.name), {
                    recursive: entry.isDirectory(),
                    force: true,
                  });
                }
              }),
            );
          }),
        );
      });
    },
  };
}
