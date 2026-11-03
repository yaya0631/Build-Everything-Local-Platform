import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    open: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/js/**/*.js'],
      exclude: ['src/js/views/**', 'src/js/app.js', 'src/main.js'],
    },
  },
});
