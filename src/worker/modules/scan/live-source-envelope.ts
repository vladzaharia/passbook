import { z } from 'zod';
import { IdSchema, ModeSchema } from '../../../shared/contracts/common.ts';
import { decryptSecret, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { fromBase64Url, toBase64Url } from '../../platform/ids.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';

const PREFIX = 'v1.';
const MAX_TOKEN_CHARS = 4_000_000;
const MAX_PLAINTEXT_BYTES = 2_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const envelopeSchema = z.strictObject({
  orgId: IdSchema,
  mode: ModeSchema,
  scannerId: IdSchema,
  eventId: IdSchema,
  kekVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
  iv: z.string().regex(/^[A-Za-z0-9_-]+$/),
  wrappedDek: z.string().regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

export interface LiveSourceBinding {
  orgId: string;
  mode: 'live' | 'test';
  scannerId: string;
  eventId: string;
}

function aad(binding: LiveSourceBinding): string {
  return JSON.stringify([
    'scan-live-source-proof.v1',
    binding.orgId,
    binding.mode,
    binding.scannerId,
    binding.eventId,
  ]);
}

function decoded(value: string): Uint8Array | null {
  const bytes = fromBase64Url(value);
  return toBase64Url(bytes) === value ? bytes : null;
}

/** Encrypt the captured source under a versioned KEK and bind it to its public event identity. */
export async function sealLiveSourceEnvelope(
  env: object,
  plaintext: Uint8Array,
  originalBinding: LiveSourceBinding,
): Promise<string> {
  const keyEnv = captureCredentialKeyEnv(env);
  const binding = {
    orgId: originalBinding.orgId,
    mode: originalBinding.mode,
    scannerId: originalBinding.scannerId,
    eventId: originalBinding.eventId,
  };
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Invalid live source authority.');
  const sealed = await encryptSecret(await loadKekRing(keyEnv), plaintext, aad(binding));
  const envelope = {
    ...binding,
    kekVersion: sealed.kekVersion,
    iv: toBase64Url(sealed.iv),
    wrappedDek: toBase64Url(sealed.wrappedDek),
    ciphertext: toBase64Url(sealed.ciphertext),
  };
  const token = PREFIX + toBase64Url(encoder.encode(JSON.stringify(envelope)));
  if (token.length > MAX_TOKEN_CHARS) throw new Error('Invalid live source authority.');
  return token;
}

/** Reject malformed envelopes, unavailable KEKs and any change to the authenticated binding. */
export async function openLiveSourceEnvelope(
  env: object,
  token: string,
): Promise<{ plaintext: Uint8Array; binding: LiveSourceBinding } | null> {
  const keyEnv = captureCredentialKeyEnv(env);
  try {
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > MAX_TOKEN_CHARS)
      return null;
    const encoded = token.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = decoded(encoded);
    if (!bytes) return null;
    const json = decoder.decode(bytes);
    const parsed = envelopeSchema.safeParse(JSON.parse(json));
    if (!parsed.success || JSON.stringify(parsed.data) !== json) return null;
    const { orgId, mode, scannerId, eventId, kekVersion } = parsed.data;
    const binding = { orgId, mode, scannerId, eventId };
    const iv = decoded(parsed.data.iv);
    const wrappedDek = decoded(parsed.data.wrappedDek);
    const ciphertext = decoded(parsed.data.ciphertext);
    if (
      iv?.length !== 12 ||
      wrappedDek?.length !== 60 ||
      !ciphertext ||
      ciphertext.length < 16 ||
      ciphertext.length > MAX_PLAINTEXT_BYTES + 16
    )
      return null;
    const plaintext = await decryptSecret(
      await loadKekRing(keyEnv),
      { kekVersion, iv, wrappedDek, ciphertext },
      aad(binding),
    );
    return { plaintext, binding };
  } catch {
    return null;
  }
}
