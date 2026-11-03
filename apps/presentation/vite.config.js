import { defineConfig } from "vite";
export default defineConfig({
  plugins: [],
  base: "./",
  test: { include: ["tests/**/*.test.js", "lib/**/*.test.ts"] },
});
