import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  base: './',
  build: { target: 'es2022', cssTarget: 'safari15' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
