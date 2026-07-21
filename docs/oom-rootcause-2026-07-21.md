# Railway OOM — root cause found (2026-07-21)

**Status:** ROOT CAUSE CONFIRMED (code audit + local reproduction + upstream-issue corroboration).
The `43bd6cf` hardening (2026-07-16) did **not** fix it — it mitigated the wrong surface and, worse,
the one change that mattered (`idleTimeout: 60`) made the leak *hold longer*.

## The leak: `/mcp` leaks a full MCP server graph per request

`src/lib/agent.ts` `app.all('/mcp', ...)` uses the stateless "fresh server per request" pattern:

```ts
const transport = new WebStandardStreamableHTTPServerTransport();
const mcpServer = createSolEnrichMcpServer();   // registers ~30 tools + Zod schemas + an Ajv validator
await mcpServer.connect(transport);
c.req.raw.signal.addEventListener('abort', () => { transport.close(); mcpServer.close(); });
return transport.handleRequest(c.req.raw);
```

Two independent ways this retains memory permanently:

### 1. GET /mcp opens an immortal SSE stream (primary)
`WebStandardStreamableHTTPServerTransport.handleGetRequest` (SDK 1.27.1,
`webStandardStreamableHttp.js:184`) responds to any `GET` with `Accept: text/event-stream` by returning
a `ReadableStream` that the server **never writes to, never pings, and never times out**. The stream's
controller is stored in `_streamMapping`, which holds the transport, which (via `connect`) holds the
`mcpServer` and all 30 registered tools/schemas. In our **stateless** setup (no `sessionIdGenerator`, no
`eventStore`) that stream can never carry a server push — it is pure dead weight. Every GET probe leaks
the whole graph.

### 2. Happy-path POST never runs cleanup (secondary)
Our only teardown is the `'abort'` listener. `Request.signal` fires `abort` **only on premature client
disconnect — never on normal completion** (confirmed against Bun issues #28636/#4517). So every *completed*
POST /mcp also leaks its transport + server + the installed abort-listener closure.

### Why the 2026-07-16 memwatch couldn't name it
`transport.handleRequest()` returns the streaming Response immediately, so Hono's `await next()` resolves
and the in-flight counter decrements to zero **while the stream/transport/server stay retained** at the Bun
layer. The watchdog reports `in-flight: none`. That is exactly the "8GB spike with no invoke logs / no
trace" signature from the Jul 5 and Jul 15 kills.

### Why idleTimeout: 60 made it worse
The reap is silent (Bun #27479) and does not reliably deliver `abort`/`ReadableStream.cancel()`, so a
reaped stream's graph is **not** freed. Raising the reap from 10s → 60s just lengthened the window each
held stream survives before the socket (but not the memory) is dropped.

## Reproduction (local, Bun 1.2.21, current `main`)
- Baseline RSS: **138 MB**.
- Fired **700 raw `GET /mcp` sockets** (`Accept: text/event-stream`).
- RSS climbed to **1,827 MB** and stayed there (`[memwatch] RSS 1827MB — in-flight: none`, then 1790MB
  60s later — flat, i.e. retained not transient). Server became unresponsive (ECONNREFUSED on the tail
  of the flood).
- **~2.4 MB retained per GET probe.** Extrapolated: ~3,300 probes → 8 GB → the Railway Hobby cap.
  At the crawler rates seen since the Jul 8–10 directory submissions, that's hours, not days — matching
  the ~10-day gap between the two production kills.
- Well-behaved traffic does NOT leak: 300 fully-consumed POST inits left RSS flat (~23 MB), confirming
  the leak is specific to unclosed streams / uncleaned graphs, not MCP request volume per se.

## Corroboration (upstream, not our code)
- **modelcontextprotocol/typescript-sdk #2090** (open): stateless per-request `McpServer` allocation
  OOM-kills in production *even with* the official `res.on('close')` cleanup — per-request Ajv + 9 Maps.
  Our 30 tools make each instance heavier than their repro.
- The SDK's **web-standard** stateless example (`honoWebStandardStreamableHttp.ts`) does **no cleanup at
  all** — there is no blessed teardown for this runtime; our abort listener was a community improvisation
  with the wrong trigger semantics.
- **Bun ≤ 1.3.14** (every stable release to date) predates PR #30875 ("fix effectively every native-code
  memory leak"), which fixes ReadableStream-source and fetch retention — so the runtime amplifies (2).

## Recommended fix (in priority order)
1. **Return `405` for `GET /mcp`.** Stateless mode has no server-push; the standalone SSE stream is
   useless and is the primary leak. Only handle `POST` (and `OPTIONS`/CORS). Kills mechanism (1) outright.
2. **Clean up on completion, not just abort.** After `handleRequest` resolves, `await` the response to
   completion (or `finally`) and call `transport.close()` + `mcpServer.close()`; remove the abort listener
   on completion so its closure stops pinning the graph. Kills mechanism (2).
3. **Consider dropping full `McpServer`-per-request** for a cached tool-registry + lightweight JSON-RPC
   dispatch (per SDK #2090) — removes the baseline per-request Ajv/Map churn. Larger change; do after 1+2
   confirm the bleed stops.
4. **Keep** the `maxRequestBodySize: 1MB` cap (good). **Revisit `idleTimeout`** back toward a smaller
   value once GET is 405'd (the slow-cold-cache justification was for paid invokes, not /mcp).
5. Upgrade Bun once a release containing PR #30875 ships (> 1.3.14).

## Validation plan for the fix
Re-run the 700-GET flood against the patched build: RSS must stay near baseline (405s return instantly,
nothing retained). Then a completed-POST loop: RSS must return to baseline after each (cleanup ran).
Add a CI/regression guard that GET /mcp → 405.

## Note on prior "ruled out" conclusions
The Jul-16 audit ruled out paid paths correctly, but concluded the /mcp transport leak was *fixed* by the
abort-listener. It was not — the listener fires on the wrong event, and GET was never addressed. The
"prime suspect" instinct was right; the patch missed.
