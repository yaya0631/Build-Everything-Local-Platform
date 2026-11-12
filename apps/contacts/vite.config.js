import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  // Apps are served from /app/<name>/ on the platform, not the domain root.
  base: './',
  plugins: [],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
  test: {
    // Pure logic only — no DOM needed, so the fast node environment is enough.
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
})
