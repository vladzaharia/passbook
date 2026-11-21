import { importPKCS8, SignJWT } from 'jose';
import type { ProvisionerEnv } from './types.ts';

const TTL_SECONDS = 10 * 60;
let cached: { p8: string; key: CryptoKey } | undefined;

/** The key is imported once per isolate and never extractable. */
async function signingKey(p8: string): Promise<CryptoKey> {
  if (cached?.p8 !== p8)
    cached = { p8, key: await importPKCS8(p8, 'ES256', { extractable: false }) };
  return cached.key;
}

/** One JWT per Apple call: ES256, `aud` appstoreconnect-v1, 10 minutes (Apple's limit is 20). */
export async function mintJwt(
  env: Pick<ProvisionerEnv, 'ASC_KEY_P8' | 'ASC_KEY_ID' | 'ASC_ISSUER_ID'>,
  nowMs: number,
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })
    .setIssuer(env.ASC_ISSUER_ID)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt(iat)
    .setExpirationTime(iat + TTL_SECONDS)
    .sign(await signingKey(env.ASC_KEY_P8));
}
