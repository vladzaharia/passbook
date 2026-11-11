import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionAuthority } from './access.ts';
import type { ConnectionRow } from './repo.ts';
import {
  deleteCredentials,
  discardCredential,
  getCredential,
  insertCredential,
} from './repo-credentials.ts';

type Kind = 'connector' | 'webhook';

/** Stores a new credential row (rotation = new id) and returns its id. The value is never readable via the API. */
export async function storeCredential(
  ctx: ServiceContext,
  input: { orgId: string; kind: Kind; value: string; createdBy: string | null },
  authority?: ConnectionAuthority,
): Promise<string> {
  const id = ctx.ids.id();
  const ring = await loadKekRing(ctx.env);
  const envelope = await encryptSecret(
    ring,
    input.value,
    credentialAad(id, input.orgId, input.kind),
  );
  // Short fingerprint: enough to tell two secrets apart, too short to confirm a guess.
  const fingerprint = (await sha256Hex(`${id}|${input.value}`)).slice(0, 8);
  try {
    const inserted = await insertCredential(
      ctx.env.DB,
      {
        id,
        orgId: input.orgId,
        kind: input.kind,
        envelope,
        fingerprint,
        createdBy: input.createdBy,
        now: ctx.clock.now(),
      },
      authority,
    );
    if (!inserted) throw new ForbiddenError();
  } catch (error) {
    // A failed response can follow a committed insert. Delete only this unreferenced envelope.
    await discardCredential(ctx.env.DB, { id, orgId: input.orgId, envelope });
    throw error;
  }
  return id;
}

/** Removes credentials only if no connection or signing identity references them. */
export async function dropCredentials(ctx: ServiceContext, ids: (string | null)[]): Promise<void> {
  await deleteCredentials(ctx.env.DB, ids);
}

async function read(
  ctx: ServiceContext,
  orgId: string,
  id: string | null,
  kind: Kind,
): Promise<string | undefined> {
  if (!id) return undefined;
  const row = await getCredential(ctx.env.DB, orgId, id);
  if (!row) return undefined;
  return decryptSecretText(
    await loadKekRing(ctx.env),
    row.envelope,
    credentialAad(id, orgId, kind),
  );
}

export async function readConnectorSecrets(
  ctx: ServiceContext,
  conn: ConnectionRow,
): Promise<Record<string, unknown> | undefined> {
  const text = await read(ctx, conn.orgId, conn.credentialId, 'connector');
  return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

export function readWebhookSecret(
  ctx: ServiceContext,
  conn: ConnectionRow,
): Promise<string | undefined> {
  return read(ctx, conn.orgId, conn.webhookCredentialId, 'webhook');
}

export function newWebhookSecret(ctx: ServiceContext): string {
  return `whsec_${ctx.ids.token(32)}`;
}
