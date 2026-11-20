import type { ServiceContext } from '../../platform/service-context.ts';
import { liveRecipient } from './live-auth.ts';
import { pulseTag, socketAttachment } from './scan-hub-support.ts';

/** The message an operator device gets when its session has a new scan. It carries no data: the device reads again. */
export const PULSE = JSON.stringify({ pulse: 1 });

/**
 * Tell the device sockets of one scanning session that something was scanned in it. Two fences,
 * both from the socket's own sealed attachment: the hub is already one org and mode, and the
 * device must be bound to this session. A socket whose authority no longer holds is closed, not told.
 * `sessionId` null (a scanner outside any session) reaches no one.
 */
export async function pulseDevices(
  state: DurableObjectState,
  ctx: ServiceContext,
  sessionId: string | null,
  send: (socket: WebSocket, text: string) => void,
): Promise<void> {
  if (!sessionId) return;
  // Only device sockets carry the session tag: the rest are never opened, let alone decrypted.
  await Promise.all(
    state.getWebSockets(pulseTag(sessionId)).map(async (socket) => {
      const attachment = await socketAttachment(ctx, socket);
      if (attachment?.role !== 'device' || attachment.session?.id !== sessionId) return;
      if (!(await liveRecipient(ctx, attachment))) socket.close(4409, 'Setup changed');
      else send(socket, PULSE);
    }),
  );
}
