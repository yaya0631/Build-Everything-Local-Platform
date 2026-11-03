import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  base: './',
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
