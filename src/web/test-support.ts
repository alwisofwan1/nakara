// Test helper: createApp whose requests come from the Operator by default (own
// Host, Bearer token). Tests of the auth gate itself import the real createApp.
import { generateKeyPairSync, sign } from "node:crypto";

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

export const ACCESS_TEAM = "https://team.cloudflareaccess.com";
export const ACCESS_AUD = "aud-tag";
export const ACCESS_NOW = 1_800_000_000_000;

/** An RSA key as Cloudflare Access publishes it, and a signer for Access JWTs (exp relative to ACCESS_NOW). */
export function accessKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const jwt = (claims: Record<string, unknown>, kid = "k1") => {
    const enc = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "RS256", kid })}.${enc({
      iss: ACCESS_TEAM,
      aud: [ACCESS_AUD],
      email: "op@example.com",
      exp: ACCESS_NOW / 1000 + 600,
      ...claims,
    })}`;
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return { jwk, jwt };
}
