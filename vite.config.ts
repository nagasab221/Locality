import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer is loaded from file:// in production, so all asset URLs must be relative.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
});
