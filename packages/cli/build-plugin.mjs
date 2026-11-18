// Bundles the CLI into one file for the Claude Code plugin, so it runs with plain `node`.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: [fileURLToPath(new URL('./src/cli.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../../plugins/change-contract/bin/contract.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
});
