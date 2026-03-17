import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  deps: {
    // better-sqlite3 は native addon なのでバンドル不可。
    // それ以外の devDependencies は全てバンドルして dependencies ゼロを実現。
    neverBundle: ['better-sqlite3'],
    onlyBundle: false,
  },
});
