// Bundles the Action into one file, so it runs without installing anything.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
});
