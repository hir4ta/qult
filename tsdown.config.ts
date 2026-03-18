import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
    loader: { '.tmpl': 'text' },
    deps: {
      neverBundle: ['better-sqlite3'],
      onlyBundle: false,
    },
  },
  {
    entry: ['src/postinstall.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    loader: { '.tmpl': 'text' },
    deps: {
      neverBundle: ['better-sqlite3'],
      onlyBundle: false,
    },
  },
]);
