import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function findWorker(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findWorker(path);
      if (found) return found;
    } else if (entry.name.includes('pdf.worker')) {
      return path;
    }
  }
  return null;
}

export function pluginSingleFileHtml() {
  return {
    name: 'single-file-html',
    apply: 'build',
    setup(api) {
      api.onAfterBuild(async ({ environments }) => {
        await Promise.all(
          Object.values(environments).map(async (environment) => {
            const worker = await findWorker(environment.distPath);
            if (worker) {
              const workerSource = await readFile(worker, 'utf8');
              const workerDataUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
              const workerRelativePath = relative(
                environment.distPath,
                worker,
              ).replaceAll('\\', '/');
              for (const htmlPath of Object.values(environment.htmlPaths)) {
                const html = await readFile(
                  join(environment.distPath, htmlPath),
                  'utf8',
                );
                const inlinedHtml = html.replaceAll(
                  workerRelativePath,
                  workerDataUrl,
                );
                await writeFile(
                  join(environment.distPath, htmlPath),
                  inlinedHtml,
                );
              }
            }
            const htmlFiles = new Set(Object.values(environment.htmlPaths));
            const entries = await readdir(environment.distPath, {
              withFileTypes: true,
            });
            await Promise.all(
              entries.map((entry) => {
                if (!htmlFiles.has(entry.name)) {
                  return rm(join(environment.distPath, entry.name), {
                    recursive: entry.isDirectory(),
                    force: true,
                  });
                }
                return Promise.resolve();
              }),
            );
          }),
        );
      });
    },
  };
}
