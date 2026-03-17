import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  deps: { neverBundle: ['better-sqlite3'] },
});
