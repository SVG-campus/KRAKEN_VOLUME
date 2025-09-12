const path = require('path');
const react = require("@vitejs/plugin-react");
const { defineConfig } = require("vite");
const tailwindcss = require("tailwindcss");
const tailwindConfig = require("./tailwind.config.js");
const autoprefixer = require("autoprefixer");

module.exports = defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindConfig), autoprefixer],
    },
  },
  server: {
    port: 3001, // Run dev server on a different port than the backend
  },
});