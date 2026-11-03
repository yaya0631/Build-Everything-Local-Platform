import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  base: './',
  build: { target: 'es2022', cssTarget: 'safari15', chunkSizeWarningLimit: 900 },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
