import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env bun' },
  loader: { '.tmpl': 'text' },
  deps: {
    neverBundle: ['bun:sqlite'],
    onlyBundle: false,
  },
});
