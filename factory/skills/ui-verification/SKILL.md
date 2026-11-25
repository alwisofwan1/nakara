---
name: ui-verification
description: How to produce and judge visual proof of a user-facing change in this factory.
---

# UI verification

The implement agent runs on the browser runner: `playwright-cli` and Chromium are installed in its container. Proof is a screenshot of the running change for each acceptance criterion a user can see. Nakara posts the screenshots on the PR and in the requester's thread; you never host images yourself.

1. Start the app with the repository's documented dev command, in the background, and wait until it responds on `localhost`. The browser reaches `localhost` directly; the internet is reachable only through the egress proxy.
2. Drive the exact acceptance path with `playwright-cli`: `playwright-cli open http://localhost:<port>`, then `click`, `fill`, `press` and so on, and `playwright-cli screenshot --filename=.nakara-proof/<name>.png` at each state that proves a criterion. Use `playwright-cli snapshot` to find element references. Close the browser with `playwright-cli close` when done.
3. Write `.nakara-proof/proof.json` in the repository root: a list with one entry per screenshot, in the order a reviewer should read them.

   ```json
   [
     { "criterion": "The playground lists slugify, truncate and wrap", "screenshot": "home.png" },
     { "criterion": "An empty input shows an inline error", "screenshot": "empty-error.png" }
   ]
   ```

   `criterion` is the acceptance criterion, worded as in the issue or spec. `screenshot` is a PNG, JPEG, WebP or GIF inside `.nakara-proof/`, at most 10 MB. Write the file again on every run that changes the UI: only a proof.json written during the run is collected, and it replaces the proof of earlier runs.
4. `.nakara-proof/` and `.playwright-cli/` are excluded from git in this clone; never commit them or force-add them.
5. In the PR description, list each criterion with the steps you ran and what its screenshot shows. Nakara adds the images to the PR in a comment titled "Evidence".
6. If the app cannot run here (missing services, secrets, or toolchain), say so explicitly in the PR and in your report. Never claim an unverified UI change passed.

Proof that shows the wrong path, an incomplete state, or a missing criterion counts as missing proof. Nakara reports refused entries (a path outside the directory, a link, another file type) to the foreman.
