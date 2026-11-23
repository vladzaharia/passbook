import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanLiveDraft } from '../../../shared/contracts/scan-draft.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { liveRecipient } from './live-auth.ts';
import { type CustomerSay, draftView, entryIsLive, watches } from './live-render.ts';
import { DEVICE_TAG, readRing, socketAttachment } from './scan-hub-support.ts';

/** A draft names a desk read no older than this, the time a customer screen keeps a ready card. */
export const DRAFT_WINDOW_MS = 60_000;

export interface DraftInput {
  orgId: string;
  mode: Mode;
  /** The ready card's live row id (`liveReadyId`). */
  readyId: string;
  /** The caller's scanner: the ready card must come from it. */
  scannerId: string;
  /** The review body. Absent: cancel the draft and the ready card. */
  say?: CustomerSay;
  now?: number;
}

/**
 * Tell the customer screens that follow a scanner about a draft, or clear it. Never the ring, a
 * snapshot, a monitor or a device socket. A draft needs the scanner's own ready card, presented and
 * under a minute old, and reaches a screen only while its session shows drafts and the pass is
 * current for it. Returns the screens told; null when the ready card is not there to draft over
 * (a cancel never is: it only clears).
 */
export async function draftToScreens(
  state: DurableObjectState,
  ctx: ServiceContext,
  input: DraftInput,
  send: (socket: WebSocket, text: string) => void,
): Promise<number | null> {
  const now = ctx.clock.now();
  const entry = (await readRing(state.storage, now)).find((r) => r.row.id === input.readyId);
  const { say } = input;
  const own = entry?.row.kind === 'ready' && entry.row.scannerId === input.scannerId;
  if (!entry || !own) return say ? null : 0;
  if (say && (!entry.row.presented || now - entry.row.at > DRAFT_WINDOW_MS || !entry.row.passId))
    return null;
  let sent = 0;
  await Promise.all(
    state.getWebSockets().map(async (socket) => {
      if (state.getTags(socket).some((t) => t.startsWith(DEVICE_TAG))) return;
      const attachment = await socketAttachment(ctx, socket);
      const recipient = attachment ? await liveRecipient(ctx, attachment) : null;
      if (!recipient) {
        socket.close(4409, 'Setup changed');
        return;
      }
      if (recipient.actor.scanner?.deviceRole !== 'customer' || !watches(recipient, entry)) return;
      let draft: ScanLiveDraft = { ref: entry.row.id, at: now, cancelled: true };
      if (say) {
        if (recipient.customer.showDraft === false || !(await entryIsLive(ctx, recipient, entry)))
          return;
        draft = {
          ref: entry.row.id,
          at: now,
          customer: { ...draftView(recipient, entry, say), at: now },
        };
      }
      send(socket, JSON.stringify({ draft }));
      sent++;
    }),
  );
  return sent;
}
