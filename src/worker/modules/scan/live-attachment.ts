import { z } from 'zod';
import { IdSchema, ModeSchema, RoleSchema } from '../../../shared/contracts/common.ts';
import { OrgRolesSchema } from '../../../shared/contracts/org-membership.ts';
import {
  decryptSecret,
  derivedHmacKey,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { fromBase64Url, safeEqualBytes, toBase64Url } from '../../platform/ids.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { cloneLiveAttachment, type LiveAttachment } from './live-auth.ts';
import { epochsSchema } from './live-snapshot-schemas.ts';

const PREFIX = 'v1.';
const MAX_TOKEN_CHARS = 4_000_000;
const MAX_PLAINTEXT_BYTES = 2_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const session = z.strictObject({
  id: IdSchema,
  status: z.enum(['active', 'paused', 'ended']),
  updatedAt: timestamp,
});
const tenantAuthority = z.strictObject({
  kind: z.literal('session'),
  orgId: IdSchema,
  orgUpdatedAt: timestamp,
  userId: IdSchema,
  sessionId: z.string().min(1),
  sessionRoles: z.array(RoleSchema).min(1),
  amr: z.enum(['oidc', 'magic_link', 'breakglass']),
  membershipId: IdSchema,
  roles: OrgRolesSchema,
  capability: z.literal('scanning:read'),
  mode: ModeSchema,
  sessionCreatedAt: timestamp,
  sessionExpiresAt: timestamp,
  sessionCsrfProof: proof,
});
const attachmentSchema = z
  .strictObject({
    orgId: IdSchema,
    mode: ModeSchema,
    scannerId: IdSchema,
    role: z.enum(['customer', 'monitor']),
    tokenHash: z.union([z.literal(''), hex]),
    scannerCsrfProof: proof.nullable(),
    credentialKeysetCommitment: hex,
    revision: timestamp,
    expiresAt: timestamp,
    session: session.nullable(),
    actor: z.unknown(),
    // Epochs ride on a symbol key that JSON drops, so they travel beside the actor.
    epochs: epochsSchema,
    observation: z.unknown(),
    admin: z
      .strictObject({ sessionId: z.string().min(1), userId: IdSchema, tenantAuthority })
      .optional(),
  })
  .refine((a) =>
    a.admin
      ? a.admin.sessionId === a.admin.tenantAuthority.sessionId &&
        a.admin.userId === a.admin.tenantAuthority.userId &&
        a.orgId === a.admin.tenantAuthority.orgId &&
        a.mode === a.admin.tenantAuthority.mode
      : !!a.tokenHash && a.scannerCsrfProof !== null,
  );

const envelopeSchema = z.strictObject({
  scannerId: IdSchema,
  binding: proof,
  kekVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
  iv: z.string().regex(/^[A-Za-z0-9_-]+$/),
  wrappedDek: z.string().regex(/^[A-Za-z0-9_-]+$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

function decoded(value: string): Uint8Array | null {
  const bytes = fromBase64Url(value);
  return toBase64Url(bytes) === value ? bytes : null;
}

function bindingInput(a: LiveAttachment): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      'scan-live-attachment-binding.v1',
      a.orgId,
      a.mode,
      a.scannerId,
      a.role,
      a.admin?.sessionId ?? null,
      a.admin?.userId ?? null,
      a.tokenHash,
      a.scannerCsrfProof,
      a.session?.id ?? null,
      a.session?.updatedAt ?? null,
      a.revision,
      a.credentialKeysetCommitment,
      a.expiresAt,
    ]),
  );
}

function aad(scannerId: string, binding: string): string {
  return JSON.stringify(['scan-live-attachment.v1', scannerId, binding]);
}

/** Seal the authenticated scanner/session snapshot for internal transport and hibernation. */
export async function sealLiveAttachment(env: object, attachment: LiveAttachment): Promise<string> {
  const keyEnv = captureCredentialKeyEnv(env);
  const captured = cloneLiveAttachment(attachment);
  if (!captured) throw new Error('Invalid live attachment');
  const parsed = attachmentSchema.safeParse(captured);
  if (!parsed.success) throw new Error('Invalid live attachment');
  const plaintext = encoder.encode(JSON.stringify(parsed.data));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Invalid live attachment');
  const material = bindingInput(captured);
  const [ring, bindingKey] = await Promise.all([
    loadKekRing(keyEnv),
    derivedHmacKey(keyEnv, 'scan-live-attachment-binding.v1'),
  ]);
  const binding = toBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', bindingKey, material as BufferSource)),
  );
  const sealed = await encryptSecret(ring, plaintext, aad(parsed.data.scannerId, binding));
  const outer = {
    scannerId: parsed.data.scannerId,
    binding,
    kekVersion: sealed.kekVersion,
    iv: toBase64Url(sealed.iv),
    wrappedDek: toBase64Url(sealed.wrappedDek),
    ciphertext: toBase64Url(sealed.ciphertext),
  };
  const token = PREFIX + toBase64Url(encoder.encode(JSON.stringify(outer)));
  if (token.length > MAX_TOKEN_CHARS) throw new Error('Invalid live attachment');
  return token;
}

/** Decode an internal attachment; malformed, tampered and unavailable-key tokens fail closed. */
export async function openLiveAttachment(
  env: object,
  token: string,
): Promise<LiveAttachment | null> {
  try {
    const keyEnv = captureCredentialKeyEnv(env);
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > MAX_TOKEN_CHARS)
      return null;
    const encoded = token.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const bytes = decoded(encoded);
    if (!bytes) return null;
    const outerJson = decoder.decode(bytes);
    const outer = envelopeSchema.safeParse(JSON.parse(outerJson));
    if (!outer.success || JSON.stringify(outer.data) !== outerJson) return null;
    const { scannerId, binding, kekVersion } = outer.data;
    const iv = decoded(outer.data.iv);
    const wrappedDek = decoded(outer.data.wrappedDek);
    const ciphertext = decoded(outer.data.ciphertext);
    if (
      iv?.length !== 12 ||
      wrappedDek?.length !== 60 ||
      !ciphertext ||
      ciphertext.length < 16 ||
      ciphertext.length > MAX_PLAINTEXT_BYTES + 16
    )
      return null;
    const [ring, bindingKey] = await Promise.all([
      loadKekRing(keyEnv),
      derivedHmacKey(keyEnv, 'scan-live-attachment-binding.v1'),
    ]);
    const plaintext = await decryptSecret(
      ring,
      { kekVersion, iv, wrappedDek, ciphertext },
      aad(scannerId, binding),
    );
    const innerJson = decoder.decode(plaintext);
    const attachment = attachmentSchema.safeParse(JSON.parse(innerJson));
    if (
      !attachment.success ||
      JSON.stringify(attachment.data) !== innerJson ||
      attachment.data.scannerId !== scannerId
    )
      return null;
    const captured = cloneLiveAttachment(attachment.data as LiveAttachment);
    if (!captured) return null;
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', bindingKey, bindingInput(captured) as BufferSource),
    );
    const actual = decoded(binding);
    if (actual?.length !== 32 || !safeEqualBytes(actual, expected)) return null;
    return captured;
  } catch {
    return null;
  }
}
