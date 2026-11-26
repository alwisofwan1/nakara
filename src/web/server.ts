import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";

import { backupHealth } from "../backup.ts";
import type { Config } from "../config.ts";
import type { GithubPoller } from "../intake/github.ts";
import { agentTokenOf } from "../runner/agent-token.ts";
import {
  definitionDirWarning,
  type FactoryRegistry,
} from "../orchestrator/registry.ts";
import { createApi } from "./api.ts";
import { accessVerifier } from "./cf-access.ts";
import { securityWarnings } from "./definition.ts";
import { readFactories } from "./factories.ts";
import type { FetchPullRequest } from "./pull-request.ts";
import type { WizardDeps } from "./wizard.ts";

type Env = { Bindings: HttpBindings };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Factory pages that moved under /f/<slug>/; item and run pages stay global. */
const FACTORY_PAGE = /^\/(?:activity|agents|automations|definition)(?:\/|$)/;
const FACTORY_SCOPE = /^\/f\/([^/]+)(?:\/|$)/;

export function loadToken(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

// Byte lengths: a non-ASCII string can match in characters and still differ in bytes.
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Host headers the server answers to: its configured host, loopback names on its port, the public URL's host, NAKARA_ALLOWED_HOSTS. */
function allowedHostSet(config: Config): Set<string> {
  const hosts = new Set<string>();
  for (const name of ["127.0.0.1", "localhost", "[::1]", config.host])
    hosts.add(`${name}:${config.port}`);
  try {
    if (config.publicUrl) hosts.add(new URL(config.publicUrl).host);
  } catch {
    /* A malformed public URL adds no host. */
  }
  for (const extra of config.allowedHosts) hosts.add(extra);
  return new Set([...hosts].map((h) => h.toLowerCase()));
}

export function createApp(
  registry: FactoryRegistry,
  poller: GithubPoller,
  config: Config,
  token: string,
  fetchPullRequest?: FetchPullRequest,
  wizard?: WizardDeps,
) {
  const app = new Hono<Env>({
    // Accept both direct prefixed URLs and paths stripped by code-server.
    getPath: (req) => {
      const path = new URL(req.url).pathname;
      return config.basePath &&
        (path === config.basePath || path.startsWith(`${config.basePath}/`))
        ? path.slice(config.basePath.length) || "/"
        : path;
    },
  });
  const base = config.basePath;
  const store = registry.store;

  // Registered first so refusals carry the headers too. No framing: approve and
  // stop buttons must not be clickable through another page.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Radix dialogs inject a <style> element to lock page scroll.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      // Served over plain HTTP on loopback, or behind a proxy that owns HTTPS for its host.
      strictTransportSecurity: false,
    }),
  );

  // Every request, loopback included, must carry the Operator's token (ADR
  // 0004): the cookie set by ?token= or
  // `Authorization: Bearer <token>`. Only /healthz and /metrics answer a
  // loopback peer without it. A Host header that is not ours is refused first,
  // so a page cannot reach the API through DNS rebinding.
  const allowedHosts = allowedHostSet(config);
  const accessOperator = config.access && accessVerifier(config.access);
  app.use("*", async (c, next) => {
    const apiRequest = c.req.path === "/api" || c.req.path.startsWith("/api/");
    const refuse = (code: string, message: string, status: 401 | 403) =>
      apiRequest
        ? c.json({ error: { code, message } }, status)
        : c.text(message, status);
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host))
      return refuse("forbidden", "Forbidden: unknown Host", 403);
    const peer = c.env.incoming.socket.remoteAddress ?? "";
    const loopback = LOOPBACK.has(peer);
    if (!loopback && !config.allow.includes(peer.replace(/^::ffff:/, "")))
      return refuse("forbidden", "Forbidden", 403);
    const open =
      loopback &&
      ["GET", "HEAD"].includes(c.req.method) &&
      (c.req.path === "/healthz" || c.req.path === "/metrics");
    if (!open) {
      // Lax, so a link tapped in Telegram or GitHub arrives signed in; the
      // Origin check below still refuses cross-site writes. Each visit renews
      // it, so a phone in daily use never asks for the token again.
      const remember = () =>
        setCookie(c, "nakara_token", token, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
        });
      const fromQuery = c.req.query("token");
      if (fromQuery && same(fromQuery, token)) {
        remember();
        const u = new URL(c.req.url);
        u.searchParams.delete("token");
        return c.redirect(`${u.pathname}${u.search}`);
      }
      const cookie = getCookie(c, "nakara_token") ?? "";
      const bearer = /^Bearer\s+(\S+)$/i.exec(
        c.req.header("authorization") ?? "",
      )?.[1];
      const byCookie = same(cookie, token);
      const accessJwt = c.req.header("cf-access-jwt-assertion");
      const signedIn =
        byCookie ||
        (bearer !== undefined && same(bearer, token)) ||
        // Checked last: it may fetch Cloudflare's signing keys.
        (accessOperator !== undefined &&
          accessJwt !== undefined &&
          (await accessOperator(accessJwt)) !== undefined);
      if (!signedIn)
        return refuse(
          "unauthorized",
          "Unauthorized: open the URL with ?token=<token>",
          401,
        );
      // A page visit by cookie or through Cloudflare Access (re)sets the cookie.
      if (!apiRequest && c.req.method === "GET" && (byCookie || !bearer))
        remember();
    }
    if (apiRequest || !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(origin).host.toLowerCase() === host;
        } catch {
          /* Invalid origins are refused. */
        }
        if (!sameOrigin)
          return refuse("cross_origin", "Cross-origin request refused", 403);
      }
    }
    await next();
  });

  app.route(
    "/api",
    createApi(registry, config, undefined, fetchPullRequest, wizard),
  );
  app.all("/api/*", (c) =>
    c.json(
      { error: { code: "not_found", message: "API route not found" } },
      404,
    ),
  );

  app.post("/approvals/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const form = await c.req.parseBody();
    const decision = String(form.decision ?? "");
    const answer = String(form.answer ?? "").trim();
    const approval = store.approval(id);
    if (!approval) return c.notFound();
    if (decision === "reject" && !answer)
      return c.text("Say what should change in the spec.", 400);
    try {
      (registry.forItem(approval.item_id) ?? registry.default).answerApproval(
        id,
        { approved: decision === "approve", answer },
      );
    } catch (error) {
      return c.text(String(error), 409);
    }
    return c.redirect(`/items/${approval.item_id}`);
  });

  app.get("/healthz", (c) => {
    const mismatch = registry.definitionDirMismatch();
    return c.json({
      ok: true,
      // Every factory has a valid definition; factories names the ones without.
      definition: registry.factories.every((f) => Boolean(f.definition)),
      factories: Object.fromEntries(
        registry.factories.map((f) => [
          f.record?.slug ?? "",
          {
            definition: Boolean(f.definition),
            // The source only, never the value.
            agentToken: agentTokenOf(f.record?.slug).source,
          },
        ]),
      ),
      lastPoll: poller.lastPoll,
      backup: backupHealth(config.backup),
      warnings: [
        ...new Set(
          registry.factories.flatMap((f) =>
            securityWarnings(store, f.definition, f.record?.slug),
          ),
        ),
        ...(mismatch ? [definitionDirWarning(mismatch)] : []),
      ],
      schemaVersion: store.schemaVersion,
    });
  });

  app.get("/metrics", (c) => {
    const { metrics } = registry.telemetry;
    metrics.queueDepth.set({ role: "agent" }, store.queuedRuns().length);
    metrics.queueDepth.set(
      { role: "foreman" },
      store.itemsWithPendingEvents().length,
    );
    return c.text(metrics.render(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  app.use(
    "/assets/*",
    serveStatic({
      root: "./dist/web",
      rewriteRequestPath: (path) =>
        base && path.startsWith(`${base}/`) ? path.slice(base.length) : path,
    }),
  );
  app.get("/assets/*", (c) => c.notFound());
  app.get("*", async (c) => {
    if (/^\/api(?:\/|$)/.test(c.req.path)) return c.notFound();
    // Old links to factory pages open the first factory's page.
    if (FACTORY_PAGE.test(c.req.path))
      return c.redirect(
        `${base}/f/${encodeURIComponent(store.repos.factories.defaultFactory().slug)}${c.req.path}${new URL(c.req.url).search}`,
      );
    const scope = FACTORY_SCOPE.exec(c.req.path)?.[1];
    if (
      scope !== undefined &&
      !store.repos.factories.factory(decodeSegment(scope))
    )
      return c.text("Factory not found", 404);
    const index = await readFile("dist/web/index.html", "utf8").catch(
      () => null,
    );
    if (!index) return c.text("Web build missing. Run npm run build.", 503);
    const runtime = JSON.stringify({
      basePath: base,
      factories: readFactories(store.repos.factories),
    }).replaceAll("<", "\\u003c");
    return c.html(
      index.replace(
        "<!--runtime-config-->",
        `<base href="${escapeHtml(`${base}/`)}"><script id="nakara-config" type="application/json">${runtime}</script>`,
      ),
    );
  });
  return app;
}

/** A malformed escape such as %E0 names no factory. */
const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
