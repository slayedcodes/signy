#!/usr/bin/env node
// Runs the TypeScript source directly; the plugin ships a bundled copy (plugins/change-contract/bin).
import { register } from 'tsx/esm/api';

register();
const { run } = await import('../src/run.ts');
await run();
