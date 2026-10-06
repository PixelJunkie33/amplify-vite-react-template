import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The spectator view is built to ./dist, which the arena server picks up and
 * serves at /watch. In development, `npm run dev:watch-ui` proxies the API
 * across to a server started with `npm start`, so the two can run side by
 * side on different ports.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
