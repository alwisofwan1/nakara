// Cloudflare Access in front of Nakara signs every request it lets through
// with a JWT in Cf-Access-Jwt-Assertion. A valid one for our Access
// application and an Operator email proves the Operator like the token does.
import { createPublicKey, type JsonWebKey, verify } from "node:crypto";

export type AccessConfig = {
  /** https://<team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
  emails: string[];
};

type Jwk = JsonWebKey & { kid?: string };
type FetchCerts = (url: string) => Promise<{ keys: Jwk[] }>;

const fetchJson: FetchCerts = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

const part = (s: string) =>
  JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

/** Returns a check that resolves to the Operator's email, or undefined for any JWT that does not prove it. */
export function accessVerifier(
  config: AccessConfig,
  fetchCerts: FetchCerts = fetchJson,
  now: () => number = Date.now,
) {
  const certsUrl = `${config.teamDomain}/cdn-cgi/access/certs`;
  const emails = new Set(config.emails.map((e) => e.toLowerCase()));
  let keys = new Map<string, Jwk>();
  let fetchedAt = 0;
  const key = async (kid: string) => {
    // Refetch hourly, and at most once a minute for a kid we do not know (key rotation).
    const age = now() - fetchedAt;
    if (age > 3600_000 || (!keys.has(kid) && age > 60_000)) {
      keys = new Map(
        (await fetchCerts(certsUrl)).keys.map((k) => [k.kid ?? "", k]),
      );
      fetchedAt = now();
    }
    return keys.get(kid);
  };
  return async (jwt: string): Promise<string | undefined> => {
    try {
      const [h, p, s] = jwt.split(".");
      if (!h || !p || !s) return undefined;
      const header = part(h);
      const claims = part(p);
      if (header.alg !== "RS256" || typeof header.kid !== "string")
        return undefined;
      const jwk = await key(header.kid);
      if (!jwk) return undefined;
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(s, "base64url"),
      );
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const seconds = now() / 1000;
      const email = String(claims.email ?? "").toLowerCase();
      return signed &&
        claims.iss === config.teamDomain &&
        aud.includes(config.aud) &&
        typeof claims.exp === "number" &&
        claims.exp > seconds &&
        !(typeof claims.nbf === "number" && claims.nbf > seconds + 60) &&
        emails.has(email)
        ? email
        : undefined;
    } catch {
      // A malformed JWT or unreachable certs: not proven, the token still works.
      return undefined;
    }
  };
}
