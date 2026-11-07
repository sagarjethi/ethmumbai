import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const API = process.env.API_URL ?? "http://127.0.0.1:18787";
const RUNNER = process.env.RUNNER_URL ?? "http://127.0.0.1:18788";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLIC_API_URL = process.env.PUBLIC_API_URL;

/** The dashboard's sample curl names the local API. A public build names the public one instead. */
const publicApiUrl: Plugin = {
  name: "public-api-url",
  apply: "build",
  renderChunk: (code) => (PUBLIC_API_URL ? code.replaceAll("http://127.0.0.1:18787", PUBLIC_API_URL) : null),
};

export default defineConfig({
  plugins: [react(), publicApiUrl],
  // Only a path for the built assets. The app calls /api and /runner from the root either way.
  base: process.env.DASHBOARD_BASE ?? "/",
  server: {
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // The admin token stays on this server, so it never reaches the browser.
        configure: (proxy) => proxy.on("proxyReq", (req) => req.setHeader("authorization", `Bearer ${ADMIN_TOKEN}`)),
      },
      "/runner": { target: RUNNER, changeOrigin: true, rewrite: (path) => path.replace(/^\/runner/, "") },
    },
  },
});
