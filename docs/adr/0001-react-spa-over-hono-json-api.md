# Web UI is a React SPA over a Hono JSON API, in the same process

Nakara's web UI is moving from server-rendered `hono/html` strings to a React 19 + Vite single-page app that talks to a typed JSON API (`/api/*`) served by the existing Hono server, inside the same process as the orchestrator, pollers and Telegram bridge. The coming pages (live run logs, a six-step wizard with state in the URL, the agents tree, the definition editor, a cross-factory inbox) are app-like, the code is mostly written by coding agents, and a separate API is what lets the read models be tested and reused by MCP, CLI and Telegram. Nakara stays single-operator: no SSR, no SEO, the existing token/cookie auth.

## Considered Options

- **Hono JSX + htmx (stay server-rendered).** Cheapest and enough for CRUD, but the wizard, tree, log tail and editor would turn into htmx plus a growing pile of hand-written JS with no types across the boundary.
- **Svelte 5.** Technically a good fit, but coding agents still write Svelte 4 / pre-runes syntax often; React has the most reliable agent output.
- **Next.js, SvelteKit, TanStack Start.** They want to own the server, which would split Nakara into two processes. The orchestrator must stay in-process with the web layer.
- **Workspaces (`apps/*`, `packages/*`).** One server and one client don't need them; the client lives in `web/` in the same package and may only `import type` from the server's API module (enforced by lint).

## Consequences

- Stack: React 19, Vite, TanStack Router (typed search params, `basename` for `NAKARA_BASE_PATH`), TanStack Query, Hono RPC (`hc<AppType>`) for end-to-end types without codegen, Radix for accessible primitives only, Tailwind v4.
- Tailwind is token-only: `@theme` resets the default palette and registers only the Pencil design tokens, so arbitrary colours like `bg-red-500` don't exist. No UI kit.
- API contract: REST per resource under `/api` (nested under `/api/f/:slug` once there are several factories), zod-validated input, one error shape `{ error: { code, message } }` with policy violations as `409 policy`, explicit DTOs rather than DB rows, no versioning (client and server ship from one build). Handlers are thin: read models are pure functions from the Store to DTOs, commands call the Factory.
- A build step exists: `vite build` emits `dist/web`, which Hono serves; the systemd unit builds before start.
- Migration is a strangler: a Foundation slice sets up the SPA, the API skeleton and the shell, then each UI slice replaces its SSR page. The last one removes `hono/html` and `style.ts`.
- Every web PR must pass Biome, typecheck, `node:test`, Vitest, `vite build` and one Playwright smoke test in CI, test its read models, and attach desktop and 390px screenshots. No visual-regression snapshots and no coverage targets.
