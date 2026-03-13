import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/runs/**", "**/server/**", "**/my_pro_chall/**", "**/node_modules/**", "**/*.db"],
    },
  },
  build: {
    outDir: "dist/client",
  },
});
