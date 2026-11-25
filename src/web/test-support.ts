// Test helper: createApp whose requests come from the Operator by default (own
// Host, Bearer token). Tests of the auth gate itself import the real createApp.
import type { Hono } from "hono";
import { createApp as createRealApp } from "./server.ts";

export function createApp(
  ...args: Parameters<typeof createRealApp>
): ReturnType<typeof createRealApp> {
  const app = createRealApp(...args);
  const [, , config, token] = args;
  const request = app.request.bind(app) as Hono["request"];
  app.request = ((input, init, env, ctx) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("host")) headers.set("host", `localhost:${config.port}`);
    if (!headers.has("authorization") && !headers.has("cookie"))
      headers.set("authorization", `Bearer ${token}`);
    return request(input, { ...init, headers }, env, ctx);
  }) as Hono["request"];
  return app;
}
