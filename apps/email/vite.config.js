import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [],
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.test.js'],
  },
});
