import {
  credentialAad,
  decryptSecretText,
  type Envelope,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { fromBase64, toBase64 } from '../../platform/ids.ts';

/**
 * A captured test-mode message holds working `/p/<token>` and `/b/<token>` links, so its body is stored
 * sealed (AAD capture id|org) and opened where the test inbox reads or forwards it: the links still work.
 * Rows captured before this prefix hold plain text and read as is.
 */
const PREFIX = 'enc1:';
const aad = (id: string, orgId: string) => credentialAad(id, orgId, 'captured-email');

export async function sealBody(
  env: object,
  id: string,
  orgId: string,
  body: string,
): Promise<string> {
  const e = await encryptSecret(await loadKekRing(env), body, aad(id, orgId));
  const parts = [e.kekVersion, e.iv, e.wrappedDek, e.ciphertext].map((p) =>
    typeof p === 'number' ? String(p) : toBase64(p),
  );
  return PREFIX + parts.join('.');
}

export async function openBody(
  env: object,
  id: string,
  orgId: string,
  stored: string,
): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored;
  const [kek = '', iv = '', wrapped = '', cipher = ''] = stored.slice(PREFIX.length).split('.');
  const e: Envelope = {
    kekVersion: Number(kek),
    iv: fromBase64(iv),
    wrappedDek: fromBase64(wrapped),
    ciphertext: fromBase64(cipher),
  };
  return decryptSecretText(await loadKekRing(env), e, aad(id, orgId));
}
