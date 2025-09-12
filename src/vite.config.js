import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal, future-proof Vite config (ESM).
export default defineConfig({
  root: ".",           // index.html is here
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
