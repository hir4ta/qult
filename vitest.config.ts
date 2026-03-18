import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'raw-tmpl',
      transform(code, id) {
        if (id.endsWith('.tmpl')) {
          return { code: `export default ${JSON.stringify(code)}`, map: null };
        }
      },
    },
  ],
  test: {
    pool: 'forks',
  },
});
