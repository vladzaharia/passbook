# Cloudflare realtime for scanner stations

> **Folded 2026-11-05** into SA §18.5 and `stations.md` §4, which win on audiences (no `manager`, no admin sockets,
> no tickets), close codes (4409 for reconfigure) and the customer buffer (30 s, replay < 10 s).

Researched 2026-11-05 against the Cloudflare docs, changelog, npm and WebKit sources (section 11), and re-verified the
same day after the restart: every limit, price and flag below was checked against the live docs, and the local toolchain
in `next/node_modules` (wrangler 4.151.1, `@cloudflare/vitest-plugin` 1.4.4) was checked for `exports` and the eviction
helpers. Covers the transport for multi-screen stations: handheld scanners, customer displays and desk monitors in any
combination, within one station or across an org.

## 0. Recommendation

| | Choice |
| --- | --- |
| **Primary** | **One SQLite-backed Durable Object per org and mode (`ScanHub`, key `<orgId>:<mode>`), raw WebSocket Hibernation API, no framework.** Scans stay HTTP; the Worker publishes each committed outcome to the hub over DO RPC; the hub fans out to sockets tagged by station, device and audience, keeps a short sequenced ring buffer in its SQLite, and replays from `since` on reconnect. |
| **Fallback** | **HTTP catch-up on the same ring buffer**: `GET /api/v1/scan/live/events?since=<seq>` (Worker → hub RPC `read`), polled every 2 s while the socket is unhealthy (5 s after 2 min), then the existing 15 s `stats` poll. D1 stays the source of truth; the hub only carries notifications. |
| **Not now** | Agents SDK runtime (0.x, 7 releases in 22 days; `State` syncs one whole value; its replay log `Streams` is experimental); PartyServer (fine but adds little); Realtime SFU / TURN / WebRTC data channels (no replay, no local dev, worse iOS resume, extra signalling); RealtimeKit (priced per participant-minute: ~$10.8k/month at our scale); MoQ relay and WebTransport (beta relay on draft protocols; a Worker can't publish to it); SSE from the hub (keeps the DO awake: ≈ $400/month); Pub/Sub (retired 2025-08-20). |

Why this one:
- **Cost at idle is zero.** A hibernated hub holds its sockets with no duration charge; app-level `ping` handled by
  `setWebSocketAutoResponse` neither wakes it nor bills. Whole platform estimate: **≈ $0.30-0.75/month** on top of the Workers
  Paid plan (section 5).
- **Latency fits the budget.** The hub is placed near its first caller (the venue's PoP), so fan-out after the D1 commit
  is one intra-Cloudflare RPC plus one socket hop: an estimated 20-80 ms, well inside 300 ms (section 8).
- **It fits the Worker as it is.** Same Worker, same deploy, same auth middleware, `vite dev` and
  `@cloudflare/vitest-plugin` run it locally with eviction and alarm helpers. Compat date `2026-08-14` already has RPC and
  `web_socket_auto_reply_to_close`.
- **One code path for scans.** The socket never carries a write that matters. Scans keep their idempotency keys, guard,
  audit and CSRF on HTTP; a lost socket costs freshness, never a check-in.

## 1. What the transport must do

| Need | Source | Consequence |
| --- | --- | --- |
| Fan-out of a scan result to every screen of a station in < 300 ms | owner | push, not poll |
| Org-wide desk monitors | owner ("desk interface shows the scans") | one hub per org, station is a filter |
| Any combination: n scanners, m displays, k desks | owner | role per socket, not per pairing topology |
| Auth per device, revocation that bites | SA §2.7 (revocation on the next request, no isolate cache) | auth at upgrade, and a kick on revoke |
| Reconnect and replay | iOS drops sockets on lock or background (section 4) | sequenced events, `since` cursor |
| Very low idle cost | owner | hibernation; nothing polls while healthy |
| Customer-safe content on customer screens | display-model §5.2 (role filter before evaluation) | render per audience on the Worker; the hub never filters content, it routes |
| Live and test never mix | SA mode model | mode in the hub key |

## 2. Options

| Option | Status (Nov 2026) | iOS Safari | Auth | Local dev and tests | Cost at our scale | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| **Durable Objects + WebSocket Hibernation** | GA. SQLite backend recommended for new classes; storage billed since Jan 2026 | WebSocket everywhere; dies on lock/background, reconnect on resume | ours: cookie or ticket checked in the Worker before the upgrade is forwarded | `vite dev` (workerd); vitest `runInDurableObject`, `evictDurableObject(stub, { webSockets: 'hibernate' })`, `runDurableObjectAlarm` | ≈ $0.30-0.75/month (section 5) | **Primary** |
| PartyServer 0.5.10 + PartySocket 1.3.0 | pre-1.0, maintained in `cloudflare/partykit`; PartySocket is dependency-free | same as above | `onBeforeConnect` returns a `Response` to refuse | same as DO | same as DO | Works; adds routing we don't need and hides the hibernation handlers we want to test directly |
| Agents SDK (`agents` 0.33.0) | pre-1.0; 0.28.1 → 0.33.0 between 13 Oct and 3 Nov 2026; 10.8 MB unpacked (AI peers all optional). Since late Oct the runtime is composable on a plain DO: `Lifecycle.install(this).use(new WebSockets()).use(new Scheduler())`; `WebSockets`, `State`, `Scheduler` marked stable, `Streams` (cursor replay log) experimental | same | authenticate in the Worker before routing; `readonly` connections; native RPC needs `await this.lifecycle.start()` | DO tooling; the docs ask for a real Lifecycle in vitest | same as DO | No for now. `State` rewrites and broadcasts one JSON value per change, not per-audience events; `Streams` is the right shape (replay from a cursor, then follow) but experimental and model-reply oriented; the release pace would churn our tests. Revisit when `Streams` is stable: the hub's wire format (section 6.2) does not depend on it |
| Realtime SFU data channels | SFU and TURN GA (Realtime launch); unordered and partially reliable DataChannels since 2026-08-13; WebSocket adapter GA 2026-09-30 (PCM audio and JPEG video only, no data) | `RTCDataChannel` since iOS 11; WebRTC suspends on lock; ICE restart on resume is slower than a WS reconnect | backend holds the app token and creates sessions; clients get session and channel ids from us | no emulator; remote API only, so worker tests must stub `fetch` | $0.05/GB egress after 1,000 GB free, shared with TURN (≈ $0) | No. One publisher to many subscribers with one selected replier; no storage or replay; a Worker is not a data participant; we would still need a signalling hub, so it adds a system rather than replacing one |
| Peer-to-peer WebRTC (scanner → display in the same room) | browser standard; TURN from Cloudflare $0.05/GB when not used with the SFU | as above | none of its own; signalling through our hub | browser-only; no worker tests | ≈ $0 | No. Saves ~20-50 ms we don't need, breaks for org-wide desks, needs the hub anyway for signalling and replay |
| RealtimeKit | GA SDKs (Core 2.0.4 on npm today) | yes | its own presets | remote only | $0.0005-0.002 per participant-minute after 10,000 min. 1,000 devices × 12 h × 30 d = 21.6 M min ≈ **$10.8k/month** audio-only | No. Meetings product |
| Server-Sent Events | standard; Workers stream responses | `EventSource` supported, built-in `Last-Event-ID` resume; same suspension | cookie | testable | from a Worker: no fan-out. From the hub: an open response stream is pending I/O, so the DO can't hibernate and bills duration while any screen is open: 200 hubs × 12 h × 30 d × 0.125 GB = 32.4 M GB-s ≈ **$400/month** | No as primary. Kept in mind if a corporate proxy ever strips WebSocket |
| MoQ relay (Media over QUIC) + WebTransport | MoQ relay beta, free during beta, IETF drafts 14 and 16; WebTransport in Safari 26.4 (Mar 2026), now Baseline | WebTransport on iOS 26.4+ only; older devices fall back to nothing | per-relay tokens in the URL path (appear in access logs) | no local relay; no Worker or DO support for QUIC or WebTransport | $0 in beta, egress-priced later | No. A Worker can't publish to it, so every result would need a browser publisher; draft protocol; tokens in URLs |
| Pub/Sub (MQTT) | **retired 2025-08-20**, never left private beta; Cloudflare points to `@cloudflare/actors` (0.0.1-beta.6) | — | — | — | — | No |
| Queues | GA, in use | — | — | yes | — | No for fan-out: consumer batching (`max_batch_timeout: 2`) puts it in seconds |
| KV, D1, Hyperdrive | GA | — | — | — | — | No push. KV is eventually consistent (~60 s); D1 has no change feed; Hyperdrive is Postgres pooling |
| Workers RPC / DO RPC | GA (compat ≥ 2024-04-03) | — | binding only | yes | 1 DO request per call | **Used** for Worker → hub `publish`, `read`, `kick` |

## 3. Facts that shape the design

Durable Objects (docs, section 11):
- `ctx.acceptWebSocket(ws, tags)` makes a socket hibernatable: up to **32,768 sockets per object**, up to **10 tags** of 256
  chars each, `ctx.getWebSockets(tag)` to select.
- `ws.serializeAttachment(v)` survives hibernation, **16,384 bytes** max; lost when the socket closes.
- `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` answers without waking the object and
  is not charged; `ctx.getWebSocketAutoResponseTimestamp(ws)` tells when a socket last pinged.
- An idle object with only hibernatable sockets hibernates after **10 s**; `setTimeout`, `setInterval`, `waitUntil`,
  outbound sockets and response streams keep it awake and billed.
- Billing: requests $0.15/M after 1 M/month (HTTP, each RPC call, alarms, socket upgrades; **incoming WS messages count
  1/20**; **outgoing messages are free**). Duration $12.50/M GB-s after 400k GB-s, at 128 MB, only while active.
  SQLite rows: 25 B reads and 50 M writes/month included; `setAlarm` is one row written.
- One alarm per object; at-least-once, 6 retries from 2 s with backoff.
- Placement: created near the first `get()`, never moves; `locationHint` (`wnam`, `enam`, `weur`, …) only on first get.
- Received message limit 32 MiB; CPU 30 s per event.
- Compat `≥ 2026-04-07` turns on `web_socket_auto_reply_to_close`; ours is `2026-08-14`, so `webSocketClose` need not call
  `ws.close()`.
- Billing rounds billable usage up to the next whole unit (1 M requests, 1 M GB-s) before the rate applies.
- `ctx.id.name` returns the name given to `getByName()`, so the hub reads its own `orgId:mode` without storing it.
- **Deploys:** since 2026-10-30 code updates are deferred by default; hibernated sockets stay connected when the object
  adopts new code. **Runtime updates** can still drop sockets, hibernated ones included. Clients must always reconnect.
- **Config:** new classes are declared in the declarative `exports` field (2026-07-04), which replaces `migrations`; a
  Worker uses one or the other. Lifecycle changes apply only through `wrangler deploy`, not `versions upload`.
- **Tests:** `evictDurableObject(stub, { webSockets: 'hibernate' | 'close' })`, `evictAllDurableObjects`,
  `runInDurableObject`, `runDurableObjectAlarm` from `cloudflare:test`; present in our `@cloudflare/vitest-plugin` 1.4.4.

## 4. iOS Safari and the screens

| Behaviour | Effect | Handling |
| --- | --- | --- |
| Safari tabs and home-screen apps are **suspended** soon after background or lock; sockets drop; `onclose` may never fire after a long suspension | a display that sleeps misses events | reconnect on `visibilitychange`, `pageshow` and `online`; don't trust `readyState`; ping on resume and reconnect if no `pong` in 2 s |
| Screen Wake Lock: Safari 16.4+, **home-screen apps only since iOS 18.4** | displays can stay awake without hacks | displays and desks request `navigator.wakeLock` on every visible; re-request after `release`; show a small "Keep this screen on" chip if refused |
| Guided Access (iPad) | keeps the display app in front | `/admin/scanners` setup copy for customer displays |
| WebRTC and audio are suspended on lock too | P2P/SFU gains nothing on iOS | not used |
| WebTransport arrived in Safari 26.4 | a QUIC option exists on new iPhones only, and nothing on Cloudflare's Worker side serves it | not used; revisit if Workers accept WebTransport |
| No Background Sync on iOS (arch-client D6) | nothing can catch up while closed | replay on reconnect; HTTP snapshot if the gap is larger than the buffer |
| Desktop Chrome throttles timers in hidden tabs (≥ 1 min chained timers after 5 min hidden) | desk heartbeat slows | server prunes by auto-response timestamp only after 5 min; the desk resyncs on visible |

## 5. Cost at PassBook scale

Assumptions: 200 orgs, 2 hubs each at most (live, test), 1,000 devices on 12 h/day, 50k scans/day, 30 days.

| Item | Volume / month | Billed |
| --- | --- | --- |
| Socket upgrades (DO request each) | 1,000 devices × 30 reconnects/day (iOS wake, network) = 0.9 M | 0.9 M |
| `publish` RPC per committed scan | 1.5 M | 1.5 M |
| Client messages (presence, `reading` beat): ~1 per scan | 1.5 M ÷ 20 | 0.075 M |
| `ping` auto-responses every 20 s while visible | 64.8 M | 0 duration (docs: auto-responses are not charged); counted at 20:1 as a worst case: 3.24 M |
| Alarms (prune hourly, only while active) | ≤ 200 × 24 × 30 = 0.14 M | 0.14 M |
| **Requests** | ≈ 2.6 M (5.9 M worst case), minus 1 M included, rounded up to whole millions | **$0.30** ($0.75 worst case) |
| Duration: ~20 ms per publish × 1.5 M × 0.125 GB | ≈ 3,750 GB-s | $0 (400k included) |
| SQLite rows: write + prune per event | 3 M | $0 (50 M included) |
| Worker requests for upgrades and catch-up | ≈ 1 M | inside the 10 M included |
| **Total** | | **≈ $0.30-0.75/month**, idle ≈ $0 |

Even at 10× scans the bill stays under $5. The cost risk is the fallback: every device polling every 2 s for 12 h would be
21.6 M DO requests a day. Hence the 2 s → 5 s → 15 s step-down and polling only while the socket is unhealthy.

## 6. Design: `ScanHub`

### 6.1 Topology

- **Key** `env.SCAN_HUB.getByName(\`${orgId}:${mode}\`)`. One per org and mode. A busy org (20 gates, 13 scans/s, SA §13.1)
  is far below a single object's throughput; per-station objects would make org-wide desks subscribe to many.
- **Tags** on each socket (max 10): `dev:<scannerId|sessionId>`, `st:<stationId>` (or `st:none`), `aud:<customer|door|desk|manager>`,
  `org` (desks watching everything), `zone:<zoneId>` (Access Card zones, when the scanner has one).
- **Station** is a server-side grouping of paired devices (defined by the station design). The hub doesn't know what a
  station is beyond the tag; membership comes from the device row at upgrade time.

### 6.2 Events

```ts
// src/shared/contracts/scan-live.ts
export const LiveEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('scan'), seq: z.number().int(), epoch: z.string(), at: z.number().int(),
             st: z.string().nullable(), scanId: z.string(), outcome: ScanOutcomeKindSchema,
             display: ScanDisplaySchema }),               // already rendered for this socket's audience
  z.object({ t: z.literal('undo'), seq, epoch, at, st, scanId }),
  z.object({ t: z.literal('beat'), st, dev: z.string(), k: z.enum(['reading', 'idle']) }), // ephemeral, no seq
  z.object({ t: z.literal('presence'), st, devices: z.array(LiveDeviceSchema) }),           // ephemeral
  z.object({ t: z.literal('hello'), seq, epoch, replayed: z.number().int() }),
  z.object({ t: z.literal('reset'), seq, epoch }),        // gap too large: client refetches a snapshot over HTTP
]);
export const LiveClientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('beat'), k: z.enum(['reading', 'idle']) }),
]);
```

- The Worker renders `display` once per audience present in the station (`customer`, staff role) with the display model,
  so role filtering stays where it is (display-model §5.2). `publish` carries `{ st, audiences: { customer?: Body, door?: Body, … } }`;
  the hub sends each socket the body for its `aud:` tag and never invents content.
- `seq` is assigned in the hub (single-threaded, so monotonic). `epoch` is a random id created with the hub's table; a
  wiped hub gets a new epoch and every client resyncs.
- `beat` lets a scanner tell its customer display "reading" before the answer, so the display's buddy can lean in
  (buddy-motion `rummage`), and is never stored.

### 6.3 Ring buffer and replay

- Table in the hub: `events(seq INTEGER PRIMARY KEY, at INTEGER, st TEXT, aud TEXT, body TEXT)`, one row per audience
  body. Keep **15 min and at most 500 seqs**; an alarm prunes hourly while rows exist and is not re-armed when empty.
- Reconnect sends `?since=<seq>&epoch=<epoch>`. Same epoch and `since ≥ minSeq − 1`: replay matching rows for the socket's
  station and audience, then `hello { replayed }`. Otherwise `reset`, and the client calls the existing snapshot
  (`GET /api/v1/scan/stats` plus the last results it shows).
- Customer bodies hold only what the customer audience may see. 15 minutes is the whole retention; the hub is not a log.
  `scans` in D1 stays the record.

### 6.4 Auth

- **Upgrade route** `GET /api/v1/scan/live` in `modules/scan/routes-live.ts`:
  1. `Upgrade: websocket` or 426.
  2. **Origin must equal `PUBLIC_BASE_URL`** (cross-site WebSocket hijacking; the cookie is `SameSite=Strict`, so this is
     a second lock, not the only one).
  3. Resolve the principal with the existing scanner middleware (cookie `__Host-wallet_scan`, prefix then hash, no isolate
     cache) or an admin session for desk monitors (`requireAdmin`, org from the query, checked against the session).
  4. Terminals (`Bearer wls_`) and any non-cookie client: `POST /api/v1/scan/live/ticket` returns a 60 s single-use ticket
     (hashed in D1 or in the hub); the client passes it as `?ticket=`. Browsers never need it.
  5. `RL_SCAN` on the upgrade; the hub keeps **at most 3 sockets per device** and closes the oldest.
  6. Forward to the hub with the verified identity in an internal header the hub trusts only because the hub is not
     routable from outside: `x-pb-live: {"dev","org","mode","st","aud","zone","exp"}`. The hub stores it with
     `serializeAttachment` and tags the socket.
- **No CSRF on the socket**: the only client message is `beat`, which changes nothing. Anything that writes stays HTTP.
- **Revocation**: `revoke`, `unpair`, staff sign-out, station change and org pause call `hub.kick({ dev })` over RPC,
  which closes those sockets with `4403`. Clients don't reconnect after `4403`; they re-run the boot gate.
- **Expiry**: attachment `exp = min(token expiry, now + 12 h)`. The hub checks it on each fan-out and closes with `4401`;
  the client reconnects, which re-runs auth.

### 6.5 Heartbeat and resume (client)

- `ping` every 20 s while visible; no `pong` within 8 s → reconnect.
- On `visibilitychange` (visible), `pageshow`, `online`: ping now, reconnect if no `pong` within 2 s.
- Backoff 0.5 s, 1 s, 2 s, 4 s, capped at 10 s, with jitter; reset after 30 s connected.
- While unhealthy: catch-up poll (section 0 fallback), and the header's live chip says **Reconnecting** (no layout shift,
  arch-client D11).

## 7. Prototype sketch

### 7.1 `wrangler.jsonc` (integration owns it)

```jsonc
"durable_objects": { "bindings": [{ "name": "SCAN_HUB", "class_name": "ScanHub" }] },
"exports": { "ScanHub": { "type": "durable-object", "storage": "sqlite" } }
```

The Worker has no Durable Objects today, so it starts on `exports` (wrangler 4.151.1's schema has it) rather than the
legacy `migrations` array. The first deploy that adds it must be `wrangler deploy` (owner only).

`src/worker/index.ts` adds `export { ScanHub } from './modules/scan/live/hub.ts';` beside the workflow exports. Then
`npm run gen` for `worker-configuration.d.ts`.

### 7.2 Hub (`src/worker/modules/scan/live/hub.ts`, ~220 lines)

```ts
import { DurableObject } from 'cloudflare:workers';

type Who = { dev: string; org: string; mode: 'live' | 'test'; st: string | null; aud: Audience; zone: string | null; exp: number };
const KEEP_MS = 15 * 60_000, KEEP_SEQ = 500, PER_DEVICE = 3;

export class ScanHub extends DurableObject<Env> {
  private epoch: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => { this.epoch = migrate(ctx.storage.sql); }); // CREATE TABLE IF NOT EXISTS; meta.epoch
    // ctx.id.name === `${orgId}:${mode}`; the hub checks it against each upgrade's `who.org`/`who.mode`.
  }

  // Worker → hub: the upgrade, already authenticated by routes-live.ts.
  async fetch(req: Request): Promise<Response> {
    const who = WhoSchema.parse(JSON.parse(req.headers.get('x-pb-live') ?? 'null'));
    this.capDevice(who.dev);                                   // close oldest beyond PER_DEVICE
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, tagsFor(who));            // dev:, st:, aud:, org, zone:
    server.serializeAttachment(who);
    const url = new URL(req.url);
    this.replay(server, who, url.searchParams.get('epoch'), Number(url.searchParams.get('since') ?? -1));
    this.presence(who.st);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Worker → hub RPC after the D1 commit. Returns the seq for the scan response.
  async publish(evt: PublishInput): Promise<number> {
    const now = evt.at;                                        // from ctx.clock in the Worker (section 9)
    const seq = this.nextSeq();
    for (const [aud, body] of Object.entries(evt.audiences)) {
      this.ctx.storage.sql.exec('INSERT INTO events (seq, at, st, aud, body) VALUES (?, ?, ?, ?, ?)',
        seq, now, evt.st, aud, JSON.stringify(body));
    }
    for (const ws of this.ctx.getWebSockets(evt.st ? `st:${evt.st}` : 'org')) this.send(ws, seq, evt, now);
    if (evt.st) for (const ws of this.ctx.getWebSockets('org')) this.send(ws, seq, evt, now);  // org desks
    await this.armPrune(now);
    return seq;
  }

  async read(since: number, st: string | null, aud: Audience) { /* fallback poll: same rows as replay */ }
  async kick(match: { dev?: string; st?: string }, code = 4403) { /* close tagged sockets */ }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const who = ws.deserializeAttachment() as Who;
    if (typeof raw !== 'string' || raw.length > 512) return ws.close(1009, 'Too big');
    const msg = LiveClientMessageSchema.safeParse(safeJson(raw));
    if (!msg.success) return ws.close(1008, 'Bad message');
    if (who.st) this.toStation(who.st, { t: 'beat', st: who.st, dev: who.dev, k: msg.data.k }, ws);
  }

  async webSocketClose(ws: WebSocket) { this.presence((ws.deserializeAttachment() as Who).st); }
  async webSocketError(ws: WebSocket) { this.presence((ws.deserializeAttachment() as Who).st); }

  async alarm() { /* DELETE old rows; close sockets whose exp passed or whose auto-response is > 5 min old; re-arm only if rows remain */ }

  private send(ws: WebSocket, seq: number, evt: PublishInput, at: number) {
    const who = ws.deserializeAttachment() as Who;
    if (who.exp < at) return ws.close(4401, 'Expired');
    const body = evt.audiences[who.aud];
    if (body) ws.send(JSON.stringify({ t: 'scan', seq, epoch: this.epoch, at, st: evt.st, ...body }));
  }
}
```

### 7.3 Route and publish (Worker)

```ts
// modules/scan/routes-live.ts
router.get('/api/v1/scan/live', requireScannerOrAdmin, async (c) => {
  if (c.req.header('upgrade') !== 'websocket') throw new UpgradeRequired();
  if (c.req.header('origin') !== c.env.PUBLIC_BASE_URL) throw new Forbidden('ORIGIN');
  const who = await live.identify(c.get('ctx'), c.get('auth'));              // service: station, audience, exp
  const hub = c.env.SCAN_HUB.getByName(`${who.org}:${who.mode}`);
  const fwd = new Request(c.req.raw, { headers: { ...plainHeaders(c.req.raw), 'x-pb-live': JSON.stringify(who) } });
  return hub.fetch(fwd);
});

// modules/scan/live/publish.ts, called by act.ts after the commit batch
export function publishScan(ctx: ServiceContext, scan: CommittedScan): void {
  ctx.waitUntil((async () => {
    try {
      const audiences = renderForStation(ctx, scan);                         // display model, once per audience
      await ctx.env.SCAN_HUB.getByName(`${scan.orgId}:${scan.mode}`).publish({ at: ctx.clock.now(),
        st: scan.stationId, scanId: scan.id, outcome: scan.outcome, audiences });
    } catch (err) {
      ctx.log.error('scan.live.publish_failed', { orgId: scan.orgId, code: 'LIVE_PUBLISH' }); // screens catch up on reconnect
    }
  })());
}
```

The publish runs in `waitUntil`, so the scanner's own answer never waits for the hub.

### 7.4 Client (`src/web/scan/live/socket.ts`, ~120 lines, no dependency)

```ts
export function openLive(opts: { onEvent(e: LiveEvent): void; onHealth(h: 'live' | 'reconnecting'): void }) {
  let ws: WebSocket | null = null, seq = load('seq', -1), epoch = load('epoch', ''), tries = 0, pongTimer = 0;
  const connect = () => {
    ws = new WebSocket(`${wsOrigin()}/api/v1/scan/live?since=${seq}&epoch=${epoch}`);
    ws.onmessage = (m) => {
      if (m.data === 'pong') return clearTimeout(pongTimer);
      const e = LiveEventSchema.parse(JSON.parse(m.data));
      if ('seq' in e && e.epoch === epoch && e.seq <= seq) return;          // replay duplicate
      if ('seq' in e) ({ seq, epoch } = save(e));
      opts.onEvent(e);
    };
    ws.onopen = () => { tries = 0; opts.onHealth('live'); };
    ws.onclose = (c) => { if (c.code === 4403) return revoked(); retryLater(); };
  };
  const ping = (wait: number) => { ws?.send('ping'); pongTimer = window.setTimeout(reconnect, wait); };
  setInterval(() => document.visibilityState === 'visible' && ping(8000), 20_000);
  for (const ev of ['visibilitychange', 'pageshow', 'online']) addEventListener(ev, () => ping(2000));
  connect();
  return { beat: (k: 'reading' | 'idle') => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'beat', k })) };
}
```

`retryLater` backs off 0.5-10 s with jitter and starts the catch-up poll; `reconnect` closes and reconnects at once.
The same module serves scanners, customer displays and desks (one implementation, owner direction).

### 7.5 Tests

| Layer | Test |
| --- | --- |
| Worker (`@cloudflare/vitest-plugin`) | upgrade without cookie → 401; wrong Origin → 403; revoked scanner → 401 |
| | two sockets on a station + one `org` desk: `publish` reaches all three; a socket on another station gets nothing |
| | customer socket gets the customer body only; a body missing for an audience sends nothing |
| | `evictDurableObject(stub, { webSockets: 'hibernate' })`, then `publish`: sockets still receive, attachments restored |
| | `since` replay: 3 events, reconnect with `since=1` → 2 replayed then `hello { replayed: 2 }`; old epoch → `reset` |
| | `kick({ dev })` closes with 4403; `exp` in the past closes with 4401 on the next fan-out |
| | `runDurableObjectAlarm`: rows older than 15 min deleted; alarm not re-armed when empty |
| | `act` commit calls `publish` once per scan; a failing hub never fails the scan |
| Unit | client socket state machine with a fake WebSocket: duplicate seq dropped, backoff, `visibilitychange` ping |
| e2e (Playwright) | two contexts on `vite dev`: scanner scans, customer display shows the result card; assert < 300 ms locally; kill the socket, scan twice, reconnect, both appear in order |

## 8. Latency budget (estimates to measure in the e2e and on devices)

| Step | Estimate |
| --- | --- |
| Scanner HTTP `actions` answered (SA §13.1 target) | p95 ≤ 150 ms from request |
| Worker → hub RPC (`publish`, started in `waitUntil` right after commit; hub placed near the venue) | 5-30 ms |
| Hub SQLite insert + fan-out | 1-5 ms |
| Hub → screen over an open socket (same metro) | 10-40 ms |
| **Commit → other screens** | **≈ 20-80 ms**; with the scan request itself, other screens update about when the scanner does |

Placement: the hub is created at the first `getByName`, which runs in the Worker serving that org's first upgrade or scan,
so it lands near the venue. Orgs that span continents get the first site's location; that's acceptable at ~100-150 ms
extra, still inside budget. Use `locationHint` only if measurements say so.

## 9. Fit with the codebase and rules

- **SA §13.1 says "No Durable Object".** That decision was about counts, and it stands: counts stay exact in D1. The hub
  is added only for push and replay; it holds no source of truth, and the scan path never awaits it.
- **Layering.** `routes-live.ts` (upgrade, Origin, auth) → `live/service.ts` (identify, render audiences) → hub. The hub is
  infrastructure like a repo: SQL appears only in `hub.ts` and its migration helper.
- **Clock and ids.** AGENTS.md wants `ctx.clock.now()` in services. The hub isn't a service; pass `at` from the Worker in
  `publish` (it already has `ctx.clock`) and use it as the event time, keeping `Date.now()` out except in `alarm()`.
- **Logs.** `scan.live.connect`, `scan.live.kick`, `scan.live.publish_failed` with `orgId` and `code` only; never bodies,
  names or tickets.
- **Files.** `hub.ts` ~220, `routes-live.ts` ~80, `service.ts` ~120, `publish.ts` ~60, client `socket.ts` ~120 and
  `use-live.ts` ~60. All under 300.
- **Bundle.** No new client dependency. The socket module goes in the scan chunk; displays load it too.
- **Changes outside the scan module** (each small, say so in the report): `wrangler.jsonc` binding and migration
  (integration), `src/worker/index.ts` export (integration), `security-headers.ts` CSP `connect-src 'self'` already covers
  `wss:` on the same origin in WebKit and Chromium (verify on device), `docs/operations.md` (hub runbook: kick, wipe).
- **Data.** No D1 migration for the transport. Live tickets, if built, add `scan_live_tickets` or live in the hub.

## 10. Risks and open questions

1. **Corporate networks that block WebSocket.** Rare on 443 through Cloudflare; the HTTP catch-up covers it at a cost.
   Measure with the first pilot venue before considering SSE.
2. **Desk monitors via admin session.** Admin sessions span orgs; the desk chooses the org at connect. Decide whether a
   desk should instead be a paired device with role `desk` (simpler revocation, same cookie) — recommended.
3. **Customer audience in the display model.** The display model has `door`, `desk`, `manager`; the station design must
   add a `customer` audience with its own allow-list. The transport assumes it.
4. **Agents SDK later.** If an AI or long-running station agent ever lands, the hub can move under `agents` without
   changing the wire format; not worth the dependency now.
5. **DO placement never moves.** If an org relocates, wipe its hub (new epoch); clients resync.
6. **Runtime updates drop sockets.** Our own deploys don't (deferred code updates keep hibernated sockets), but Cloudflare
   runtime updates can, for every device at once. Jittered backoff (section 6.5) spreads the reconnect burst; the 3-per-
   device cap and `RL_SCAN` on the upgrade bound it.

## 11. Sources

- Durable Objects WebSockets and Hibernation API: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- DurableObjectState API (`acceptWebSocket` limits, tags, auto-response): https://developers.cloudflare.com/durable-objects/api/state/
- Durable Objects pricing (requests, 20:1 WS ratio, outgoing free, auto-response not charged, SQLite rows): https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects limits (32 MiB messages, CPU): https://developers.cloudflare.com/durable-objects/platform/limits/
- Lifecycle (10 s hibernation, what blocks it): https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Data location and `locationHint`: https://developers.cloudflare.com/durable-objects/reference/data-location/
- Testing Durable Objects (`evictDurableObject`, `runDurableObjectAlarm`): https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
- SQLite storage billing from Jan 2026: https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/
- WebSocket message size 32 MiB: https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/
- Workers RPC: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Agents SDK client and state: https://developers.cloudflare.com/agents/agent-class/communication-channels/chat/client-sdk/ and https://developers.cloudflare.com/agents/runtime/capabilities/websockets/
- PartyServer and PartySocket: https://github.com/cloudflare/partykit/tree/main/packages/partyserver and https://github.com/cloudflare/partykit/tree/main/packages/partysocket
- npm (checked 2026-11-05): `agents` 0.33.0 (2026-11-03), `partyserver` 0.5.10 (2026-08-03), `partysocket` 1.3.0 (2026-06-23), `@cloudflare/actors` 0.0.1-beta.6, `@cloudflare/realtimekit` 2.0.4
- Realtime SFU, data channels, pricing, TURN: https://developers.cloudflare.com/realtime/sfu/ , https://developers.cloudflare.com/realtime/sfu/datachannels/ , https://developers.cloudflare.com/realtime/sfu/pricing/ , https://developers.cloudflare.com/realtime/turn/
- Realtime launch (SFU and TURN GA): https://blog.cloudflare.com/introducing-cloudflare-realtime-and-realtimekit/
- WebSocket adapter GA (audio/video): https://developers.cloudflare.com/changelog/post/2026-09-30-websocket-adapter-ga/
- RealtimeKit and pricing: https://developers.cloudflare.com/realtime/realtimekit/ and https://developers.cloudflare.com/realtime/realtimekit/pricing/
- Pub/Sub retirement notice: https://www.answeroverflow.com/m/1389361809856790701
- `RTCDataChannel` support (Safari/iOS 11+): https://caniuse.com/mdn-api_rtcdatachannel
- iOS background suspension of sockets: https://developer.apple.com/forums/thread/716118 , https://developer.apple.com/forums/thread/696310 , https://developer.apple.com/forums/thread/774239
- Wake Lock in home-screen apps fixed in iOS 18.4: https://bugs.webkit.org/show_bug.cgi?id=254545 , https://caniuse.com/wake-lock
- Compatibility flag `web_socket_auto_reply_to_close`: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-auto-reply-to-close
- Deferred code updates (2026-10-30): https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/
- Declarative `exports` for DO classes: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ and https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/
- Eviction test helpers: https://developers.cloudflare.com/changelog/post/2026-06-25-durable-object-eviction-test-helpers/ and https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- Agents runtime, capabilities, WebSockets, State, Streams: https://developers.cloudflare.com/agents/runtime/ , https://developers.cloudflare.com/agents/runtime/capabilities/ , https://developers.cloudflare.com/agents/runtime/capabilities/websockets/ , https://developers.cloudflare.com/agents/runtime/capabilities/streams/
- SFU DataChannel delivery options (2026-08-13): https://developers.cloudflare.com/changelog/post/2026-08-13-datachannels-reliability-ordering/
- Realtime pricing (SFU, TURN, adapter share 1,000 GB): https://developers.cloudflare.com/realtime/sfu/platform/pricing/
- RealtimeKit rates ($0.002 A/V, $0.0005 audio-only per participant-minute after 10,000): https://developers.cloudflare.com/realtime/realtimekit/platform/pricing/
- MoQ relay (beta, drafts 14 and 16, URL tokens): https://developers.cloudflare.com/moq/
- WebTransport in Safari 26.4: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
