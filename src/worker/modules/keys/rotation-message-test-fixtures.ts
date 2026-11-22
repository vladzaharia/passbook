import { type Envelope, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { run } from '../../platform/db.ts';
import { googleMessageAad } from '../wallet-providers/google-message-aad.ts';
import type { Samsung, Seeded } from './rotation-test-fixtures.ts';

const bytes = (e: Envelope) => [e.kekVersion, e.iv, e.wrappedDek, e.ciphertext] as const;

/**
 * Two change messages sealed under their own AAD (instance and row id), for the rotation to move and open: a pending
 * one, and a settled one that the settled-final trigger must still let the re-wrap touch. `kind` is the instance.
 */
export async function seedGoogleMessage(
  t: Samsung,
  kek1: string,
): Promise<Seeded['plain'][number][]> {
  const { kit } = t;
  const ring = await loadKekRing({ KEK_V1: kek1 });
  const rows = [
    { base: 1, state: 'pending', settled: null },
    { base: 2, state: 'notified', settled: kit.clock.now() },
  ];
  const out: Seeded['plain'][number][] = [];
  for (const r of rows) {
    const text = `google-message-body-${r.state}`;
    const id = kit.ctx.ids.id();
    const sealed = await encryptSecret(ring, text, googleMessageAad(t.operation.instanceId, id));
    await run(
      kit.env.DB,
      `INSERT INTO wallet_google_messages
       (id, instance_id, operation_id, base_version, target_version, notify, state, tries,
        kek_version, iv, wrapped_dek, ciphertext, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        t.operation.instanceId,
        t.operation.id,
        r.base,
        r.base + 1,
        r.state,
        ...bytes(sealed),
        kit.clock.now(),
        r.settled,
      ],
    );
    out.push({
      table: 'wallet_google_messages',
      id,
      org: kit.org.id,
      kind: t.operation.instanceId,
      text,
    });
  }
  return out;
}
