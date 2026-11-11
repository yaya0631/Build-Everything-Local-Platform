import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  // Relative asset URLs so a build can be dropped at any path — including a
  // Everything app subdirectory — without a rebuild.
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
