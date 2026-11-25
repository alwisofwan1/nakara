import { test } from "node:test";
import assert from "node:assert/strict";

import { branchProtection, type GhApi } from "./repos.ts";

const ghError = (stderr: string) => () =>
  Promise.reject(
    Object.assign(new Error("Command failed"), { cmd: "gh api", stderr }),
  );
const notFound = ghError("gh: Branch not protected (HTTP 404)\n");
const forbidden = ghError(
  "gh: Resource not accessible by personal access token (HTTP 403)\n",
);

/** A fake `gh api` answering the rules and classic protection endpoints. */
const gh =
  (
    rules: unknown[] | (() => Promise<string>),
    classic: () => Promise<string>,
  ): GhApi =>
  async (path) =>
    path.includes("/rules/branches/")
      ? typeof rules === "function"
        ? rules()
        : JSON.stringify(rules)
      : classic();

test("an unprotected default branch is reported", async () => {
  const warning = await branchProtection("o", "r", "main", gh([], notFound));
  assert.match(
    warning ?? "",
    /main allows direct pushes or merges without an approving review/,
  );
  assert.match(warning ?? "", /main allows force pushes/);
});

test("a ruleset requiring reviews and blocking force pushes passes", async () => {
  const rules = [
    {
      type: "pull_request",
      parameters: { required_approving_review_count: 1 },
    },
    { type: "non_fast_forward" },
  ];
  assert.equal(
    await branchProtection("o", "r", "main", gh(rules, notFound)),
    null,
  );
});

test("classic protection without required reviews is reported", async () => {
  const classic = async () =>
    JSON.stringify({
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
    });
  assert.match(
    (await branchProtection("o", "r", "main", gh([], classic))) ?? "",
    /without an approving review/,
  );
  const reviewed = async () =>
    JSON.stringify({
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      allow_force_pushes: { enabled: false },
    });
  assert.equal(
    await branchProtection("o", "r", "main", gh([], reviewed)),
    null,
  );
});

test("classic protection that administrators bypass is reported", async () => {
  const bypassed = async () =>
    JSON.stringify({
      enforce_admins: { enabled: false },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      allow_force_pushes: { enabled: false },
    });
  assert.match(
    (await branchProtection("o", "r", "main", gh([], bypassed))) ?? "",
    /does not apply to administrators/,
  );
});

test("a rules response that is not an array counts as no rules", async () => {
  const odd = async () => JSON.stringify({ message: "Upgrade to GitHub Pro" });
  assert.match(
    (await branchProtection("o", "r", "main", gh(odd, notFound))) ?? "",
    /main allows direct pushes/,
  );
  const garbage = async () => "not json";
  assert.match(
    (await branchProtection("o", "r", "main", gh(garbage, notFound))) ?? "",
    /Could not verify/,
  );
});

test("unreadable rulesets and no classic protection is unverified, not unprotected", async () => {
  assert.match(
    (await branchProtection("o", "r", "main", gh(forbidden, notFound))) ?? "",
    /Could not verify that main requires reviewed pull requests \(gh: Resource not accessible/,
  );
});

test("protection the token cannot read is reported as unverified", async () => {
  assert.match(
    (await branchProtection("o", "r", "main", gh([], forbidden))) ?? "",
    /Could not verify that main requires reviewed pull requests \(gh: Resource not accessible/,
  );
});
