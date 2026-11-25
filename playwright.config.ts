import { defineConfig } from "@playwright/test";

const cases = [
  { name: "root", port: 7791, base: "" },
  { name: "proxy", port: 7792, base: "/proxy/7788" },
];
// tests/server.ts serves with this token; every request must carry it, loopback included.
const SMOKE_TOKEN = "smoke-token";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    extraHTTPHeaders: { authorization: `Bearer ${SMOKE_TOKEN}` },
  },
  projects: [
    ...cases.map(({ name, port, base }) => ({
      name,
      use: { baseURL: `http://127.0.0.1:${port}${base}/` },
    })),
    { name: "dev", use: { baseURL: "http://127.0.0.1:5174/" } },
  ],
  webServer: [
    ...cases.map(({ port, base }) => ({
      command: "node tests/server.ts",
      env: {
        NAKARA_PORT: String(port),
        NAKARA_BASE_PATH: base,
        // The dev project reaches the 7791 server through vite on 5174, keeping the browser's Host.
        NAKARA_ALLOWED_HOSTS: "127.0.0.1:5174",
      },
      url: `http://127.0.0.1:${port}${base}/api/status`,
      reuseExistingServer: false,
    })),
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
      env: { NAKARA_PORT: "7791", NAKARA_DEV_TOKEN: SMOKE_TOKEN },
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: false,
    },
  ],
});
