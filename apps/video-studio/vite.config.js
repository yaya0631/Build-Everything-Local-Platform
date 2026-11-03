import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  base: './',
  build: {
    target: 'es2022',
    cssTarget: 'safari16',
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    port: 5517,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Accessibility scans of whole panels and the audio and optical flow
    // renders take a few seconds each; leave room on busy machines.
    testTimeout: 20_000,
  },
});
