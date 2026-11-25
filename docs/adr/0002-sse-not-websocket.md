# Real-time updates use SSE, not WebSocket

Every live update in the UI flows server → client: one global `GET /api/events` stream carries thin change notifications (`{ type, id, factory? }`, no payload) that make TanStack Query refetch over REST, and `GET /api/runs/:id/log` tails a run's transcript file with the byte offset as the event id so reconnects resume via `Last-Event-ID`. User actions stay on REST, which curl, MCP and Telegram need anyway. SSE passes the code-server proxy and Cloudflare Tunnel as plain HTTP (with a 15 s heartbeat), reuses the same-origin cookie and reconnects on its own; WebSocket would add a second auth path and hand-written reconnect/replay for no two-way need. The event source is an in-process `EventEmitter`, which holds only while Nakara is one process.

Add a WebSocket endpoint for a specific feature only if one needs client → server streaming, such as an interactive terminal into an agent container.
