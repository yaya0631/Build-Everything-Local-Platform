import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5297,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
  },
});
