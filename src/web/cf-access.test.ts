import assert from "node:assert/strict";
import { test } from "node:test";

import { accessVerifier } from "./cf-access.ts";
import {
  ACCESS_AUD as AUD,
  ACCESS_NOW as NOW,
  ACCESS_TEAM as TEAM,
  accessKeys,
} from "./test-support.ts";

test("an Access JWT proves the Operator only when signed, ours, current and for an Operator email", async () => {
  const { jwk, jwt } = accessKeys();
  let fetches = 0;
  const check = accessVerifier(
    { teamDomain: TEAM, aud: AUD, emails: ["Op@Example.com"] },
    async (url) => {
      fetches++;
      assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
      return { keys: [jwk] };
    },
    () => NOW,
  );
  assert.equal(await check(jwt({})), "op@example.com");
  assert.equal(await check(jwt({ aud: ["other"] })), undefined);
  assert.equal(
    await check(jwt({ iss: "https://evil.cloudflareaccess.com" })),
    undefined,
  );
  assert.equal(await check(jwt({ exp: NOW / 1000 - 1 })), undefined);
  assert.equal(await check(jwt({ email: "someone@example.com" })), undefined);
  assert.equal(await check(jwt({}, "unknown")), undefined);
  // A signature for another email does not cover a payload that names the Operator.
  const [h, , s] = jwt({ email: "someone@example.com" }).split(".");
  const forged = Buffer.from(
    JSON.stringify({
      iss: TEAM,
      aud: [AUD],
      email: "op@example.com",
      exp: NOW / 1000 + 600,
    }),
  ).toString("base64url");
  assert.equal(await check(`${h}.${forged}.${s}`), undefined);
  assert.equal(await check("not-a-jwt"), undefined);
  // An unknown kid within a minute of the last fetch does not refetch.
  assert.equal(fetches, 1);
});

test("unreachable signing keys prove nothing and do not throw", async () => {
  const { jwt } = accessKeys();
  const check = accessVerifier(
    { teamDomain: TEAM, aud: AUD, emails: ["op@example.com"] },
    async () => {
      throw new Error("offline");
    },
    () => NOW,
  );
  assert.equal(await check(jwt({})), undefined);
});
