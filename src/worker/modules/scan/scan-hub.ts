import { DurableObject } from 'cloudflare:workers';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { AppEnv } from '../../platform/env.ts';
import { problemResponse } from '../../platform/errors.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { openLiveAttachment } from './live-attachment.ts';
import {
  cloneLiveAttachment,
  type LiveAttachment,
  type LiveRecipient,
  liveRecipient,
} from './live-auth.ts';
import { liveRowFor, liveRowsFor } from './live-render.ts';
import { LIVE_ROW_TTL_MS, type LiveRingRow, ringRowOf } from './live-ring.ts';
import { getScanner } from './repo-device.ts';
import { staleScanRead } from './stale-read.ts';

const RING = 'recent';

/** Pin one key ring for every asynchronous live operation. */
function liveContext(env: AppEnv) {
  const ctx = createDetachedContext(env);
  return { ...ctx, env: snapshotCredentialEnv(env) };
}

/** The unexpired ring, oldest first; an entry from before plain rows is kept as a redacted row. */
async function readRing(storage: DurableObjectStorage, now: number): Promise<LiveRingRow[]> {
  const stored = (await storage.get<unknown[]>(RING)) ?? [];
  return stored
    .map(ringRowOf)
    .filter((r): r is LiveRingRow => r !== null && now - r.row.at < LIVE_ROW_TTL_MS);
}

/** A sealed attachment the hub no longer serves: lost access is a bare 401, drift a 409 to reconnect. */
async function refusedUpgrade(ctx: ServiceContext, attachment: LiveAttachment): Promise<Response> {
  const captured = cloneLiveAttachment(attachment);
  if (!captured || captured.expiresAt <= ctx.clock.now())
    return new Response(null, { status: 401 });
  const refusal = await staleScanRead(ctx, captured.actor);
  return refusal.status === 409 ? problemResponse(refusal) : new Response(null, { status: 401 });
}

/** One org and mode per object. HTTP mutations remain in D1; this is a bounded display feed. */
export class ScanHub extends DurableObject<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get('x-pb-live');
    if (!raw || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 400 });
    const ctx = liveContext(this.env);
    const attachment = await openLiveAttachment(ctx.env, raw);
    if (!attachment) return new Response(null, { status: 401 });
    const recipient = await liveRecipient(ctx, attachment);
    if (!recipient) return refusedUpgrade(ctx, attachment);
    if (!(await this.tenant(attachment.orgId, attachment.mode)))
      return new Response(null, { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const previous = this.ctx.getWebSockets(attachment.scannerId);
    for (const socket of previous.slice(0, Math.max(0, previous.length - 2)))
      socket.close(4408, 'Too many screens');
    server.serializeAttachment(raw);
    this.ctx.acceptWebSocket(server, [attachment.scannerId]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    await this.schedule(attachment.expiresAt);
    server.send(JSON.stringify(await this.snapshotFor(ctx, attachment, undefined, recipient)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(input: { orgId: string; mode: Mode; row: LiveRingRow }): Promise<boolean> {
    const ctx = liveContext(this.env);
    const { orgId, mode, row: entry } = input;
    const { row } = entry;
    if (!(await this.tenant(orgId, mode))) return false;
    const source = await getScanner(ctx.env.DB, row.scannerId);
    if (
      !source ||
      source.orgId !== orgId ||
      source.mode !== mode ||
      source.deviceRole !== 'scan' ||
      source.revokedAt !== null
    )
      return false;
    const now = ctx.clock.now();
    const previous = await readRing(this.ctx.storage, now);
    if (previous.some((r) => r.row.id === row.id)) return true;
    const rows = [...previous, entry]
      // Random event IDs have no chronological order. Stable sorting preserves arrival
      // order for same-millisecond events so reconnect cursors cannot skip them.
      .sort((a, b) => a.row.at - b.row.at)
      .slice(-100);
    await this.ctx.storage.put(RING, rows);
    await this.schedule(now + LIVE_ROW_TTL_MS);
    await Promise.all(
      this.ctx.getWebSockets().map(async (socket) => {
        const sealed: unknown = socket.deserializeAttachment();
        const attachment =
          typeof sealed === 'string' ? await openLiveAttachment(ctx.env, sealed) : null;
        const recipient = attachment ? await liveRecipient(ctx, attachment) : null;
        if (!recipient) {
          socket.close(4409, 'Setup changed');
          return;
        }
        const body = await liveRowFor(ctx, recipient, entry);
        if (body) this.send(socket, JSON.stringify({ rows: [body], cursor: row.id }));
      }),
    );
    return true;
  }

  async snapshot(attachment: LiveAttachment, after?: string | null) {
    const ctx = liveContext(this.env);
    return this.snapshotFor(ctx, attachment, after);
  }

  private async snapshotFor(
    ctx: ServiceContext,
    attachment: LiveAttachment,
    after?: string | null,
    authenticated?: LiveRecipient,
  ) {
    const captured = cloneLiveAttachment(attachment);
    if (!captured) return { rows: [], cursor: null };
    const recipient = authenticated ?? (await liveRecipient(ctx, captured));
    if (!recipient) return { rows: [], cursor: null };
    if (!(await this.tenant(captured.orgId, captured.mode))) return { rows: [], cursor: null };
    const ring = await readRing(this.ctx.storage, ctx.clock.now());
    // A customer reconnect never replays a previous person's result.
    if (captured.role === 'customer') return { rows: [], cursor: ring.at(-1)?.row.id ?? null };
    const index = after ? ring.findIndex((r) => r.row.id === after) : -1;
    const rows = await liveRowsFor(ctx, recipient, ring.slice(index + 1));
    return { rows, cursor: ring.at(-1)?.row.id ?? null };
  }

  /** Server-side only: the retained, unexpired ring entry of a live event, for its photo. */
  async ringRow(eventId: string): Promise<LiveRingRow | null> {
    const ctx = liveContext(this.env);
    return (
      (await readRing(this.ctx.storage, ctx.clock.now())).find((r) => r.row.id === eventId) ?? null
    );
  }

  async kick(scannerId: string) {
    const sockets = this.ctx.getWebSockets(scannerId);
    for (const socket of sockets) {
      this.send(socket, JSON.stringify({ control: 'reset' }));
      socket.close(4409, 'Setup changed');
    }
    return sockets.length;
  }

  override webSocketMessage(socket: WebSocket) {
    socket.close(1008, 'Read only');
  }
  override webSocketClose(socket: WebSocket, code: number) {
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code);
  }
  override webSocketError(socket: WebSocket) {
    socket.close(1011, 'Connection failed');
  }

  override async alarm() {
    const ctx = liveContext(this.env);
    const now = ctx.clock.now();
    const rows = await readRing(this.ctx.storage, now);
    if (rows.length) await this.ctx.storage.put(RING, rows);
    else await this.ctx.storage.delete(RING);
    for (const socket of this.ctx.getWebSockets()) {
      const sealed: unknown = socket.deserializeAttachment();
      const attachment =
        typeof sealed === 'string' ? await openLiveAttachment(ctx.env, sealed) : null;
      if (
        !attachment ||
        attachment.expiresAt <= ctx.clock.now() ||
        !(await liveRecipient(ctx, attachment))
      )
        socket.close(4401, 'Reconnect');
      else await this.schedule(attachment.expiresAt);
    }
    if (rows.length) await this.schedule((rows[0]?.row.at ?? now) + LIVE_ROW_TTL_MS);
  }

  private async schedule(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private async tenant(orgId: string, mode: Mode) {
    const expected = `${orgId}:${mode}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<string>('tenant');
      if (current) return current === expected;
      await transaction.put('tenant', expected);
      return true;
    });
  }

  private send(socket: WebSocket, text: string) {
    try {
      socket.send(text);
    } catch {
      createDetachedContext(this.env).log.warn('scan.live_socket_failed', {
        code: 'SCAN_LIVE_SOCKET_FAILED',
      });
      socket.close(1011, 'Connection failed');
    }
  }
}
