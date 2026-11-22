import { type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { run } from '../../platform/db.ts';
import { googleMessageAad } from '../wallet-providers/google-message-aad.ts';
import type { Samsung, Seeded } from './rotation-test-fixtures.ts';

const bytes = (e: Envelope) => [e.kekVersion, e.iv, e.wrappedDek, e.ciphertext] as const;

/** A change message sealed under its own AAD (instance and row id), for the rotation to move and open. Its `kind` is the instance. */
export async function seedGoogleMessage(
  t: Samsung,
  kek1: string,
): Promise<Seeded['plain'][number]> {
  const { kit } = t;
  const text = 'google-message-body';
  const id = kit.ctx.ids.id();
  const sealed = await encryptSecret(
    await loadKekRing({ KEK_V1: kek1 }),
    text,
    googleMessageAad(t.operation.instanceId, id),
  );
  await run(
    kit.env.DB,
    `INSERT INTO wallet_google_messages
     (id, instance_id, operation_id, base_version, target_version, notify, state, tries,
      kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, ?, 1, 2, 1, 'pending', 0, ?, ?, ?, ?, ?)`,
    [id, t.operation.instanceId, t.operation.id, ...bytes(sealed), kit.clock.now()],
  );
  return {
    table: 'wallet_google_messages',
    id,
    org: kit.org.id,
    kind: t.operation.instanceId,
    text,
  };
}
