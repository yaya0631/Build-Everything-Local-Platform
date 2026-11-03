import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [],
  build: {
    target: 'es2022',
    cssTarget: 'safari15',
    rollupOptions: {
      input: { main: 'index.html' },
    },
  },
  server: {
    port: 5291,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
  },
});
