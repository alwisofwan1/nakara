// Allowlisting forward proxy for agent containers. It runs in its own container
// (see ensureEgress in docker.ts), the only one on the runner's internal Docker
// network that also reaches the internet. HTTPS goes through CONNECT; plain
// HTTP through absolute-form requests. Only node builtins: the file is mounted
// into the runner image and started with `node`.
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";

export const EGRESS_PORT = 3128;

/** `example.com` matches that host only; `*.example.com` matches its subdomains. */
export function allowedHost(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p;
  });
}

/** `host:port` or `[v6]:port` from a CONNECT target. */
function target(authority: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(authority);
  return m?.[1] && m[2] ? { host: m[1], port: Number(m[2]) } : null;
}

/** HTTPS tunnels go to 443 only, plain HTTP to 80 only; tests pass their own. */
export function egressProxy(
  allow: string[],
  ports = { connect: 443, http: 80 },
): Server {
  const deny = (host: string) =>
    console.error(`egress denied: ${host} (host or port not allowed)`);
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (
      url.protocol !== "http:" ||
      Number(url.port || 80) !== ports.http ||
      !allowedHost(url.hostname, allow)
    ) {
      deny(url.host);
      res.writeHead(403).end(`${url.host} is not on the egress allowlist\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    // The Host the client sent could name another site behind the allowed
    // host's server or CDN; only the checked host goes upstream.
    headers.host = url.host;
    const upstream = request(
      {
        host: url.hostname,
        port: ports.http,
        path: url.pathname + url.search,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () =>
      res.headersSent ? res.destroy() : res.writeHead(502).end(),
    );
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    const t = target(req.url ?? "");
    if (!t || t.port !== ports.connect || !allowedHost(t.host, allow)) {
      deny(String(req.url));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    let open = false;
    const upstream = connect(t.port, t.host, () => {
      open = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () =>
      open ? socket.destroy() : socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
    );
    socket.on("error", () => upstream.destroy());
  });
  return server;
}

if (import.meta.main) {
  const allow = (process.env.NAKARA_EGRESS_ALLOW ?? "")
    .split(",")
    .filter(Boolean);
  egressProxy(allow).listen(EGRESS_PORT, () =>
    console.error(`egress proxy allows ${allow.join(", ") || "nothing"}`),
  );
}
