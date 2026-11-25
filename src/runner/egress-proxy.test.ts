import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { allowedHost, egressProxy } from "./egress-proxy.ts";

test("allowlist entries match a host exactly or, with *., its subdomains", () => {
  const allow = ["github.com", "*.githubusercontent.com"];
  assert.ok(allowedHost("github.com", allow));
  assert.ok(allowedHost("GitHub.com.", allow));
  assert.ok(allowedHost("raw.githubusercontent.com", allow));
  assert.ok(!allowedHost("githubusercontent.com", allow));
  assert.ok(!allowedHost("api.github.com", allow));
  assert.ok(!allowedHost("evilgithub.com", allow));
  assert.ok(!allowedHost("github.com.evil.io", allow));
});

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

test("the proxy tunnels and forwards to allowed hosts only", async (t) => {
  const origin = createServer((req, res) => res.end(req.headers.host));
  const originPort = await listen(origin);
  const proxy = egressProxy(["localhost"], {
    connect: originPort,
    http: originPort,
  });
  const proxyPort = await listen(proxy);
  t.after(() => {
    origin.close();
    proxy.close();
  });

  const tunnel = (host: string, port = originPort) =>
    new Promise<number>((done, fail) => {
      const req = request({
        host: "127.0.0.1",
        port: proxyPort,
        method: "CONNECT",
        path: `${host}:${port}`,
      });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          done(res.statusCode ?? 0);
          return;
        }
        // Speak HTTP through the tunnel to prove it reaches the origin.
        socket.end(
          `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
        let body = "";
        socket.on("data", (d) => (body += d));
        socket.on("end", () => done(body.endsWith(host) ? 200 : 500));
      });
      req.on("error", fail);
      req.end();
    });
  assert.equal(await tunnel("localhost"), 200);
  assert.equal(await tunnel("127.0.0.1"), 403);
  // An allowed host on another port is refused too.
  assert.equal(await tunnel("localhost", proxyPort), 403);

  const plain = (host: string, port = originPort) =>
    new Promise<number>((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `http://${host}:${port}/`,
        },
        (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      req.end();
    });
  assert.equal(await plain("localhost"), 200);
  assert.equal(await plain("127.0.0.1"), 403);
  assert.equal(await plain("localhost", proxyPort), 403);

  // The client's Host cannot point the allowed server at another site.
  const host = await new Promise<string>((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: `http://localhost:${originPort}/`,
        headers: { host: "evil.example" },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c));
        res.on("end", () => done(body));
      },
    );
    req.on("error", fail);
    req.end();
  });
  assert.equal(host, `localhost:${originPort}`);
});
