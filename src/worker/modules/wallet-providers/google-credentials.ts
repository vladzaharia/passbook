import { GoogleWalletError } from './google-errors.ts';

export const GOOGLE_WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

export interface GoogleAccountCredentials {
  issuerId: string;
  serviceAccountEmail: string;
  privateKeyPem: string;
  scopes: readonly string[];
}

export interface GoogleValidatedAccount {
  issuerId: string;
  serviceAccountEmail: string;
  scopes: readonly string[];
  signingKey: CryptoKey;
}

export function isGoogleIssuerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value) && /[1-9]/.test(value);
}

function invalidCredentials(): never {
  throw new GoogleWalletError('invalid_credentials', 'credentials');
}

/** Validates local key material, not issuer approval or Google account authorization. */
export async function validateGoogleAccount(
  input: GoogleAccountCredentials,
): Promise<GoogleValidatedAccount> {
  if (
    !input ||
    !isGoogleIssuerId(input.issuerId) ||
    typeof input.serviceAccountEmail !== 'string' ||
    !/^(?=.{1,64}@)[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+gserviceaccount\.com$/i.test(
      input.serviceAccountEmail,
    ) ||
    !Array.isArray(input.scopes) ||
    input.scopes.length !== 1 ||
    input.scopes[0] !== GOOGLE_WALLET_SCOPE ||
    typeof input.privateKeyPem !== 'string'
  ) {
    return invalidCredentials();
  }

  const match =
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----\s*$/.exec(
      input.privateKeyPem.trim(),
    );
  if (!match?.[1]) return invalidCredentials();
  let signingKey: CryptoKey;
  try {
    const encoded = match[1].replace(/\s/g, '');
    const binary = atob(encoded);
    if (btoa(binary).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      return invalidCredentials();
    }
    const der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    signingKey = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    return invalidCredentials();
  }
  const algorithm = signingKey.algorithm;
  if (
    algorithm.name !== 'RSASSA-PKCS1-v1_5' ||
    !('modulusLength' in algorithm) ||
    algorithm.modulusLength < 2048
  ) {
    return invalidCredentials();
  }
  return {
    issuerId: input.issuerId,
    serviceAccountEmail: input.serviceAccountEmail,
    scopes: [GOOGLE_WALLET_SCOPE],
    signingKey,
  };
}
