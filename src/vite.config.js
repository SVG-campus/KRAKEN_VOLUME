import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tailwindcss from "tailwindcss";
import tailwindConfig from "./tailwind.config.js";
import autoprefixer from "autoprefixer";

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), autoprefixer],
    },
  },
  server: {
    port: 3001, // Run dev server on a different port than the backend
  },
})