import type { GoogleValidatedAccount } from './google-credentials.ts';
import { GoogleWalletError } from './google-errors.ts';

const encoder = new TextEncoder();

export function googleBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signGoogleJwt(
  account: GoogleValidatedAccount,
  claims: Record<string, unknown>,
): Promise<string> {
  const encode = (value: unknown) => googleBase64Url(encoder.encode(JSON.stringify(value)));
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  try {
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      account.signingKey,
      encoder.encode(input),
    );
    return `${input}.${googleBase64Url(new Uint8Array(signature))}`;
  } catch {
    throw new GoogleWalletError('invalid_credentials', 'signing');
  }
}

export function googleIssuedAt(issuedAt: number): number {
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt <= 0 ||
    issuedAt > Number.MAX_SAFE_INTEGER - 3600
  ) {
    throw new GoogleWalletError('invalid_input', 'time');
  }
  return issuedAt;
}
