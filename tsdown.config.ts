import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env bun' },
  loader: { '.tmpl': 'text' },
  define: {
    '__ALFRED_VERSION__': JSON.stringify(pkg.version),
  },
  deps: {
    neverBundle: ['bun:sqlite', '@opentui/core', '@opentui/react', 'react'],
    onlyBundle: false,
  },
});
