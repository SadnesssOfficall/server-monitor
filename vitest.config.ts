import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    typecheck: { enabled: false },
    testTimeout: 30_000,
  },
});
