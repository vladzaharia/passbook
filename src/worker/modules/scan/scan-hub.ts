import { DurableObject } from 'cloudflare:workers';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import { getScanner } from './repo-device.ts';

const TTL = 15 * 60_000;
const RING = 'recent';

/** One org and mode per object. HTTP mutations remain in D1; this is a bounded display feed. */
export class ScanHub extends DurableObject<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get('x-pb-live');
    if (!raw || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 400 });
    const attachment = JSON.parse(raw) as LiveAttachment;
    const ctx = createServiceContext(this.env);
    if (!(await liveRecipient(ctx, attachment))) return new Response(null, { status: 401 });
    if (!(await this.tenant(attachment.orgId, attachment.mode)))
      return new Response(null, { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const previous = this.ctx.getWebSockets(attachment.scannerId);
    for (const socket of previous.slice(0, Math.max(0, previous.length - 2)))
      socket.close(4408, 'Too many screens');
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [attachment.scannerId]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    await this.schedule(attachment.expiresAt);
    server.send(JSON.stringify(await this.snapshot(attachment)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(input: { orgId: string; mode: Mode; row: ScanLiveRow }): Promise<boolean> {
    if (!(await this.tenant(input.orgId, input.mode))) return false;
    const { row } = input;
    const source = await getScanner(this.env.DB, row.scannerId);
    if (
      !source ||
      source.orgId !== input.orgId ||
      source.mode !== input.mode ||
      source.deviceRole !== 'scan' ||
      source.revokedAt !== null
    )
      return false;
    const now = createServiceContext(this.env).clock.now();
    const previous = (await this.ctx.storage.get<ScanLiveRow[]>(RING)) ?? [];
    if (previous.some((r) => r.id === row.id)) return true;
    const rows = [...previous.filter((r) => now - r.at < TTL), row]
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .slice(-100);
    await this.ctx.storage.put(RING, rows);
    await this.schedule(now + TTL);
    await Promise.all(
      this.ctx.getWebSockets().map(async (socket) => {
        const attachment = socket.deserializeAttachment() as LiveAttachment;
        const ctx = createServiceContext(this.env);
        const recipient = await liveRecipient(ctx, attachment);
        if (!recipient) {
          socket.close(4409, 'Setup changed');
          return;
        }
        const body = await liveRowFor(ctx, recipient, row);
        if (body) this.send(socket, JSON.stringify({ rows: [body], cursor: row.id }));
      }),
    );
    return true;
  }

  async snapshot(attachment: LiveAttachment, after?: string | null) {
    const ctx = createServiceContext(this.env);
    const recipient = await liveRecipient(ctx, attachment);
    if (!recipient) return { rows: [], cursor: null };
    if (!(await this.tenant(attachment.orgId, attachment.mode))) return { rows: [], cursor: null };
    const ring = ((await this.ctx.storage.get<ScanLiveRow[]>(RING)) ?? []).filter(
      (r) => ctx.clock.now() - r.at < TTL,
    );
    // A customer reconnect never replays a previous person's result.
    if (attachment.role === 'customer') return { rows: [], cursor: ring.at(-1)?.id ?? null };
    const index = after ? ring.findIndex((r) => r.id === after) : -1;
    const rows = (
      await Promise.all(ring.slice(index + 1).map((row) => liveRowFor(ctx, recipient, row)))
    ).filter((r) => r !== null);
    return { rows, cursor: ring.at(-1)?.id ?? null };
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
    const now = createServiceContext(this.env).clock.now();
    const rows = ((await this.ctx.storage.get<ScanLiveRow[]>(RING)) ?? []).filter(
      (r) => now - r.at < TTL,
    );
    if (rows.length) await this.ctx.storage.put(RING, rows);
    else await this.ctx.storage.delete(RING);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as LiveAttachment;
      if (attachment.expiresAt <= now) socket.close(4401, 'Reconnect');
      else await this.schedule(attachment.expiresAt);
    }
    if (rows.length) await this.schedule((rows[0]?.at ?? now) + TTL);
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
    } catch (error) {
      createServiceContext(this.env).log.warn('scan.live_socket_failed', {
        code: 'SCAN_LIVE_SOCKET_FAILED',
        error,
      });
      socket.close(1011, 'Connection failed');
    }
  }
}
