import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __HGI_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    pool: 'forks',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
