import {
  decryptSecretText,
  type Envelope,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { googleMessageAad } from './google-message-aad.ts';

export interface GoogleMessageText {
  header: string;
  body: string;
}

/** The text carries field values: sealed at rest, never logged, never in an event. */
export async function sealGoogleMessage(
  ctx: ServiceContext,
  instanceId: string,
  id: string,
  text: GoogleMessageText,
): Promise<Envelope> {
  return encryptSecret(
    await loadKekRing(ctx.env),
    JSON.stringify({ header: text.header, body: text.body }),
    googleMessageAad(instanceId, id),
  );
}

export async function openGoogleMessages(
  ctx: ServiceContext,
  rows: readonly { id: string; instanceId: string; envelope: Envelope }[],
): Promise<GoogleMessageText[]> {
  if (rows.length === 0) return [];
  const ring = await loadKekRing(ctx.env);
  return Promise.all(
    rows.map(async (row) => {
      const value = JSON.parse(
        await decryptSecretText(ring, row.envelope, googleMessageAad(row.instanceId, row.id)),
      ) as Partial<GoogleMessageText>;
      return { header: String(value.header ?? ''), body: String(value.body ?? '') };
    }),
  );
}

/** Google's message id: not deduplicated by Google, so it is the ledger row's id, never the operation's. */
export const googleMessageId = (rowId: string): string => `pbm_${rowId.replace(/-/g, '')}`;
