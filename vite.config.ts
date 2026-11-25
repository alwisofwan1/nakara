import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

const API_SERVER = `http://127.0.0.1:${process.env.NAKARA_PORT ?? "7788"}`;

// Every API request needs the operator's token, loopback included. Browser
// requests carry it themselves; this is for the dev server's own fetch below.
const DEV_TOKEN = process.env.NAKARA_DEV_TOKEN ?? "";

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./routes",
      generatedRouteTree: "./routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
    tailwind(),
    {
      name: "nakara-dev-runtime",
      async transformIndexHtml(html, ctx) {
        if (!ctx.server) return html;
        // The dev server has no Store; the factories come from the API server.
        const factories = await fetch(`${API_SERVER}/api/factories`, {
          headers: { authorization: `Bearer ${DEV_TOKEN}` },
        })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        const runtime = JSON.stringify({ basePath: "", factories });
        return html.replace(
          "<!--runtime-config-->",
          `<script id="nakara-config" type="application/json">${runtime.replaceAll("<", "\\u003c")}</script>`,
        );
      },
    },
  ],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/healthz"].map((path) => [
        `^${path}(?:/|$)`,
        {
          target: API_SERVER,
          // Keep the browser's Host so the server's same-origin check accepts POSTs.
          changeOrigin: false,
        },
      ]),
    ),
  },
});
