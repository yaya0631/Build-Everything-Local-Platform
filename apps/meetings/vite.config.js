import { defineConfig } from 'vite';

export default defineConfig({
  // Apps are served from /app/<name>/ on the platform, not the domain root.
  base: './',
  plugins: [],
  build: {
    target: 'es2022',
    sourcemap: true,
    // AudioWorklet modules must stay real files — addModule() rejects
    // data: URLs in some browsers, and Vite would otherwise inline the
    // tiny noise-gate worklet.
    assetsInlineLimit: (filePath) => (filePath.includes('workletProcessor') ? false : undefined),
  },
  server: {
    port: 6767,
    allowedHosts: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
  },
});
