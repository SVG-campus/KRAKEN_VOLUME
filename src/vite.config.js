import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(".", "./src"),
    },
  },
  server: {
    port: 3001, // Run dev server on a different port than the backend
  },
})