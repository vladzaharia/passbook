import { DurableObject } from 'cloudflare:workers';
import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  ScanLiveEnrollSchema,
  ScanLiveResolvedSchema,
  type ScanLiveSnapshotSchema,
} from '../../../shared/contracts/scan-setups.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';
import { openLiveAttachment } from './live-attachment.ts';
import {
  cloneLiveAttachment,
  type LiveAttachment,
  type LiveRecipient,
  liveRecipient,
} from './live-auth.ts';
import { livePlaces } from './live-places.ts';
import { liveRowFor, liveRowsFor, watches } from './live-render.ts';
import { LIVE_ROW_TTL_MS, type LiveRingRow } from './live-ring.ts';
import { getScanner } from './repo-device.ts';
import { type DraftInput, draftToScreens } from './scan-hub-draft.ts';
import { pulseDevices } from './scan-hub-pulse.ts';
import { scrubRing } from './scan-hub-scrub.ts';
import {
  DEVICE_TAG,
  deviceTag,
  doorbellSockets,
  liveContext,
  RING,
  readRing,
  refusedUpgrade,
  socketAttachment,
  socketTags,
} from './scan-hub-support.ts';

/** One org and mode per object. HTTP mutations remain in D1; this is a bounded display feed. */
export class ScanHub extends DurableObject<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    const raw = request.headers.get('x-pb-live');
    if (!raw || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 400 });
    const callerNow = Number(request.headers.get('x-pb-now'));
    const ctx = liveContext(
      this.env,
      Number.isSafeInteger(callerNow) && callerNow > 0 ? callerNow : undefined,
    );
    const attachment = await openLiveAttachment(ctx.env, raw);
    if (!attachment) return new Response(null, { status: 401 });
    const recipient = await liveRecipient(ctx, attachment);
    if (!recipient) return refusedUpgrade(ctx, attachment);
    if (!(await this.tenant(attachment.orgId, attachment.mode)))
      return new Response(null, { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const device = attachment.role === 'device';
    const previous = this.ctx.getWebSockets(
      device ? deviceTag(attachment.scannerId) : attachment.scannerId,
    );
    // A device keeps its latest connection and the new one; a screen keeps two and the new one.
    for (const socket of previous.slice(0, Math.max(0, previous.length - (device ? 1 : 2))))
      socket.close(4408, device ? 'Replaced' : 'Too many screens');
    server.serializeAttachment(raw);
    this.ctx.acceptWebSocket(server, socketTags(attachment));
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    await this.schedule(attachment.expiresAt);
    if (device) return new Response(null, { status: 101, webSocket: client });
    server.send(JSON.stringify(await this.snapshotFor(ctx, attachment, undefined, recipient)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(input: {
    orgId: string;
    mode: Mode;
    row: LiveRingRow;
    /** The caller's clock reading. */
    now?: number;
  }): Promise<boolean> {
    const ctx = liveContext(this.env, input.now);
    const { orgId, mode, row: entry } = input;
    const { row } = entry;
    if (!(await this.tenant(orgId, mode))) return false;
    const source = await getScanner(ctx.env.DB, row.scannerId);
    if (
      !source ||
      source.orgId !== orgId ||
      source.mode !== mode ||
      (source.deviceRole !== 'scan' && source.deviceRole !== 'monitor') ||
      source.revokedAt !== null
    )
      return false;
    const now = ctx.clock.now();
    const previous = await this.scrub(ctx, await readRing(this.ctx.storage, now));
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
        // Device sockets get no rows.
        if (this.isDevice(socket)) return;
        const attachment = await socketAttachment(ctx, socket);
        const recipient = attachment ? await liveRecipient(ctx, attachment) : null;
        if (!recipient) {
          socket.close(4409, 'Setup changed');
          return;
        }
        const body = await liveRowFor(ctx, recipient, entry);
        if (!body) return;
        const places = await livePlaces(ctx, recipient, [entry]);
        this.send(
          socket,
          JSON.stringify({ rows: [body], cursor: row.id, ...(places.length ? { places } : {}) }),
        );
      }),
    );
    await pulseDevices(this.ctx, ctx, entry.sessionId ?? null, (s, text) => this.send(s, text));
    return true;
  }

  async snapshot(attachment: LiveAttachment, after?: string | null, now?: number) {
    const ctx = liveContext(this.env, now);
    return this.snapshotFor(ctx, attachment, after);
  }

  private async snapshotFor(
    ctx: ServiceContext,
    attachment: LiveAttachment,
    after?: string | null,
    authenticated?: LiveRecipient,
  ): Promise<z.infer<typeof ScanLiveSnapshotSchema>> {
    // The request's own time: the work below must not move the places' rev.
    const at = ctx.clock.now();
    const captured = cloneLiveAttachment(attachment);
    if (!captured) return { rows: [], cursor: null };
    const recipient = authenticated ?? (await liveRecipient(ctx, captured));
    if (!recipient || captured.role === 'device') return { rows: [], cursor: null };
    if (!(await this.tenant(captured.orgId, captured.mode))) return { rows: [], cursor: null };
    const ring = await readRing(this.ctx.storage, ctx.clock.now());
    // A customer reconnect never replays a previous person's result.
    const cursor = ring.at(-1)?.row.id ?? null;
    if (captured.role === 'customer')
      return { rows: [], cursor, welcome: recipient.customer.welcome };
    const index = after ? ring.findIndex((r) => r.row.id === after) : -1;
    const unseen = ring.slice(index + 1);
    const rows = await liveRowsFor(ctx, recipient, unseen);
    const places = await livePlaces(
      ctx,
      recipient,
      unseen.filter((entry) => watches(recipient, entry)),
      at,
    );
    return { rows, cursor, ...(places.length ? { places } : {}) };
  }

  /** Server-side only: the retained, unexpired ring entry of a live event, for its photo. */
  async ringRow(eventId: string, now?: number): Promise<LiveRingRow | null> {
    const ctx = liveContext(this.env, now);
    return (
      (await readRing(this.ctx.storage, ctx.clock.now())).find((r) => r.row.id === eventId) ?? null
    );
  }

  async kick(scannerId: string) {
    const sockets = [
      ...this.ctx.getWebSockets(scannerId),
      ...this.ctx.getWebSockets(deviceTag(scannerId)),
    ];
    for (const socket of sockets) {
      this.send(socket, JSON.stringify({ control: 'reset' }));
      socket.close(4409, 'Setup changed');
    }
    return sockets.length;
  }

  /**
   * Tell the device whose refusal was overridden, and only it: sockets are tagged by device. A socket
   * whose authority no longer holds is closed instead of told.
   */
  async resolved(input: {
    orgId: string;
    mode: Mode;
    scannerId: string;
    resolved: z.input<typeof ScanLiveResolvedSchema>;
    now?: number;
  }): Promise<number> {
    return this.toDevice(input, { resolved: ScanLiveResolvedSchema.parse(input.resolved) }, true);
  }

  /**
   * Ring a device: an admin's tag request, or its cancellation. A doorbell only: the request row is the truth,
   * and the message carries an id and an expiry, no pass data. Returns how many sockets were told.
   */
  async enroll(input: {
    orgId: string;
    mode: Mode;
    scannerId: string;
    enrollment: z.input<typeof ScanLiveEnrollSchema>;
    now?: number;
  }): Promise<number> {
    return this.toDevice(input, { enroll: ScanLiveEnrollSchema.parse(input.enrollment) }, false);
  }

  /**
   * A money draft for the customer screens that follow the scanner (null: no ready card of its own
   * to draft over), and its cancel, which also clears the ready card.
   */
  async draft(input: DraftInput & { say: NonNullable<DraftInput['say']> }) {
    return this.toScreens(input);
  }
  async clearDraft(input: Omit<DraftInput, 'say'>) {
    return this.toScreens(input);
  }

  private async toScreens(input: DraftInput) {
    const ctx = liveContext(this.env, input.now);
    if (!(await this.tenant(input.orgId, input.mode))) return input.say ? null : 0;
    return draftToScreens(this.ctx, ctx, input, (s, text) => this.send(s, text));
  }

  /** The ids with an open device socket. */
  connected(scannerIds: string[]): string[] {
    return scannerIds.filter((id) => this.ctx.getWebSockets(deviceTag(id)).length > 0);
  }

  /** `scannerId` left out: every device of the org and mode (a roll call's doorbell). */
  async toDevice(
    input: { orgId: string; mode: Mode; scannerId?: string; now?: number },
    body: object,
    /** Also the screen sockets tagged with the scanner's own id. Tag requests never go to screens. */
    screens: boolean,
  ): Promise<number> {
    const ctx = liveContext(this.env, input.now);
    if (!(await this.tenant(input.orgId, input.mode))) return 0;
    const message = JSON.stringify(body);
    let sent = 0;
    // The device's own socket, and for `resolved` the screens named by the scanner's id.
    for (const socket of doorbellSockets(this.ctx, input.scannerId, screens)) {
      const attachment = await socketAttachment(ctx, socket);
      if (!attachment || !(await liveRecipient(ctx, attachment))) {
        socket.close(4409, 'Setup changed');
        continue;
      }
      this.send(socket, message);
      sent++;
    }
    return sent;
  }

  private isDevice(socket: WebSocket): boolean {
    return this.ctx.getTags(socket).some((t) => t.startsWith(DEVICE_TAG));
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
    const rows = await this.scrub(ctx, await readRing(this.ctx.storage, now));
    if (rows.length) await this.ctx.storage.put(RING, rows);
    else await this.ctx.storage.delete(RING);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = await socketAttachment(ctx, socket);
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

  private scrub(ctx: ServiceContext, ring: LiveRingRow[]) {
    return scrubRing(this.ctx.storage, ctx, ring);
  }

  private async schedule(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private async tenant(orgId: string, mode: Mode) {
    const expected = `${orgId}:${mode}`;
    // The object's own name is its tenant: a test hub never takes a live row, and the reverse.
    const named = this.ctx.id.name;
    if (named !== undefined && named !== expected) return false;
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
