import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { buildCsp, withInlineHashes } from '../src/csp.js';

async function findWorker(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findWorker(path);
      if (found) return path;
    } else if (entry.name.includes('pdf.worker')) {
      return path;
    }
  }
  return null;
}

/*
 * The Content-Security-Policy, injected here rather than written into
 * public/index.html.
 *
 * Two reasons. The tile-host allowlist has to be the same constant the map
 * sessions build URLs from, or the two drift and the policy starts blocking the
 * app's own tiles. And the script-src hash can only be computed after the bundle
 * is inlined, which is the step this plugin performs.
 *
 * The hash is over the inline <script> body exactly as it ends up in the file,
 * which is why this runs after the worker substitution rather than before it.
 */
function injectCsp(html) {
  if (html.includes('Content-Security-Policy')) return html;

  const scriptHashes = [
    ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ]
    .map(
      (match) =>
        `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`,
    )
    .filter(Boolean);

  const policy = buildCsp(withInlineHashes({ script: scriptHashes }));
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;

  /* Into <head>, before anything it has to govern. */
  const headOpen = html.match(/<head[^>]*>/);
  if (!headOpen) return html;
  const at = headOpen.index + headOpen[0].length;
  return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
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
            const workerSource = worker ? await readFile(worker, 'utf8') : '';
            const workerDataUrl = worker
              ? `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`
              : '';
            const workerRelativePath = worker
              ? relative(environment.distPath, worker).replaceAll('\\', '/')
              : '';
            for (const htmlPath of Object.values(environment.htmlPaths)) {
              const html = await readFile(
                join(environment.distPath, htmlPath),
                'utf8',
              );
              /*
               * The worker substitution first, then the policy. The order is
               * load-bearing rather than incidental: the substitution rewrites the
               * document the inline script's hash is computed over, so hashing
               * first would emit a policy that blocks its own script.
               *
               * The policy is injected whether or not a worker was found. Tying
               * it to the worker would mean a build that somehow stopped shipping
               * PDF.js also stopped shipping the tile allowlist, which is the wrong
               * thing for the two to be coupled on.
               */
              const inlinedHtml = injectCsp(
                workerRelativePath
                  ? html.replaceAll(workerRelativePath, workerDataUrl)
                  : html,
              );
              await writeFile(
                join(environment.distPath, htmlPath),
                inlinedHtml,
              );
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
