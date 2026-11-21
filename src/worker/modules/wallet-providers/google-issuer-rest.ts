import { GoogleWalletError, googleFetch, googleHttpError } from './google-errors.ts';
import { isGoogleBearerToken } from './google-oauth.ts';

const ISSUER_API = 'https://walletobjects.googleapis.com/walletobjects/v1/issuer';

export interface GoogleIssuer {
  issuerId: string;
  name: string;
}

export interface GoogleIssuerCall {
  accessToken: string;
  fetcher?: typeof fetch;
}

async function call(
  c: GoogleIssuerCall,
  operation: string,
  url: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!isGoogleBearerToken(c.accessToken)) throw new GoogleWalletError('invalid_input', operation);
  const response = await googleFetch(
    c.fetcher ?? globalThis.fetch,
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    operation,
  );
  if (!response.ok) throw googleHttpError(operation, response.status, response.headers);
  try {
    return await response.json();
  } catch {
    throw new GoogleWalletError('invalid_response', operation);
  }
}

/** The issuer id is an int64: Google sends a number or a string. */
function issuerOf(value: unknown, operation: string): GoogleIssuer {
  const row = value as { issuerId?: unknown; name?: unknown } | null;
  const id = typeof row?.issuerId === 'number' ? String(row.issuerId) : row?.issuerId;
  if (typeof id !== 'string' || !/^[0-9]{1,32}$/.test(id))
    throw new GoogleWalletError('invalid_response', operation);
  return { issuerId: id, name: typeof row?.name === 'string' ? row.name : '' };
}

/** `issuer.list`: the issuers shared with the calling service account. */
export async function listGoogleIssuers(c: GoogleIssuerCall): Promise<GoogleIssuer[]> {
  const json = (await call(c, 'issuer list', ISSUER_API, 'GET')) as {
    resources?: unknown;
  } | null;
  if (json?.resources === undefined) return [];
  if (!Array.isArray(json.resources))
    throw new GoogleWalletError('invalid_response', 'issuer list');
  return json.resources.map((row) => issuerOf(row, 'issuer list'));
}

/** `issuer.get`: refused (403 or 404) unless the service account may act for the issuer. */
export async function getGoogleIssuer(
  c: GoogleIssuerCall,
  issuerId: string,
): Promise<GoogleIssuer> {
  if (!/^[0-9]{1,32}$/.test(issuerId)) throw new GoogleWalletError('invalid_input', 'issuer get');
  const issuer = issuerOf(
    await call(c, 'issuer get', `${ISSUER_API}/${issuerId}`, 'GET'),
    'issuer get',
  );
  if (issuer.issuerId !== issuerId) throw new GoogleWalletError('conflict', 'issuer get');
  return issuer;
}

/** `issuer.insert`: only a trusted aggregator's parent issuer may create one (a 403 otherwise). */
export async function insertGoogleIssuer(c: GoogleIssuerCall, name: string): Promise<GoogleIssuer> {
  return issuerOf(await call(c, 'issuer insert', ISSUER_API, 'POST', { name }), 'issuer insert');
}

/** `permissions.get`: the emails that hold OWNER on the issuer (lower-cased). */
export async function getGoogleIssuerOwners(
  c: GoogleIssuerCall,
  issuerId: string,
): Promise<string[]> {
  if (!/^[0-9]{1,32}$/.test(issuerId))
    throw new GoogleWalletError('invalid_input', 'permissions get');
  const json = (await call(
    c,
    'permissions get',
    `https://walletobjects.googleapis.com/walletobjects/v1/permissions/${issuerId}`,
    'GET',
  )) as { permissions?: { emailAddress?: unknown; role?: unknown }[] } | null;
  return (json?.permissions ?? [])
    .filter((p) => p.role === 'OWNER' && typeof p.emailAddress === 'string')
    .map((p) => String(p.emailAddress).trim().toLowerCase().normalize('NFC'));
}
