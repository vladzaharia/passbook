import { UpstreamError } from '../../platform/errors.ts';
import type { SafeFetch } from '../../platform/safe-fetch.ts';

const IAM_API = 'https://iam.googleapis.com/v1';
export const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** `projects/<project>/serviceAccounts/<email>/keys/<id>` as the IAM API names a key. */
const KEY_NAME = /^projects\/[A-Za-z0-9_.-]+\/serviceAccounts\/[^/\s]+\/keys\/[A-Za-z0-9]+$/;
const EMAIL = /^[A-Za-z0-9_.%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/;

export interface IamKey {
  name: string;
  userManaged: boolean;
}

const refused = (operation: string, status: number) =>
  new UpstreamError(`Google IAM ${operation} failed (${status}).`, `IAM_${status}`);

function headers(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** `keys.create`: the new key's name and its private key (a service-account JSON file, base64). */
export async function createServiceAccountKey(
  fetch: SafeFetch,
  token: string,
  email: string,
): Promise<{ name: string; privateKeyPem: string; email: string }> {
  if (!EMAIL.test(email)) throw new UpstreamError('Bad service account.', 'IAM_BAD_ACCOUNT');
  const res = await fetch(
    `${IAM_API}/projects/-/serviceAccounts/${encodeURIComponent(email)}/keys`,
    {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({
        keyAlgorithm: 'KEY_ALG_RSA_2048',
        privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
      }),
    },
  );
  if (res.status !== 200) throw refused('keys.create', res.status);
  try {
    const body = res.json<{ name?: unknown; privateKeyData?: unknown }>();
    if (typeof body.name !== 'string' || !KEY_NAME.test(body.name)) throw new Error('name');
    const file = JSON.parse(atob(String(body.privateKeyData))) as {
      private_key?: unknown;
      client_email?: unknown;
    };
    if (typeof file.private_key !== 'string' || typeof file.client_email !== 'string')
      throw new Error('file');
    return { name: body.name, privateKeyPem: file.private_key, email: file.client_email };
  } catch {
    throw new UpstreamError('Google IAM keys.create answered with no usable key.', 'IAM_BAD_KEY');
  }
}

/** `keys.delete`. A key already gone (404) counts as deleted, so a retried delete is safe. */
export async function deleteServiceAccountKey(
  fetch: SafeFetch,
  token: string,
  name: string,
): Promise<void> {
  if (!KEY_NAME.test(name)) throw new UpstreamError('Bad key name.', 'IAM_BAD_KEY');
  const res = await fetch(`${IAM_API}/${name}`, { method: 'DELETE', headers: headers(token) });
  if (res.status !== 200 && res.status !== 404) throw refused('keys.delete', res.status);
}

/** `keys.list`, user-managed keys only (Google's own system keys are not ours to count). */
export async function listServiceAccountKeys(
  fetch: SafeFetch,
  token: string,
  email: string,
): Promise<IamKey[]> {
  if (!EMAIL.test(email)) throw new UpstreamError('Bad service account.', 'IAM_BAD_ACCOUNT');
  const res = await fetch(
    `${IAM_API}/projects/-/serviceAccounts/${encodeURIComponent(email)}/keys?keyTypes=USER_MANAGED`,
    { headers: headers(token) },
  );
  if (res.status !== 200) throw refused('keys.list', res.status);
  const body = res.json<{ keys?: { name?: unknown; keyType?: unknown }[] }>();
  return (body.keys ?? []).map((k) => {
    if (typeof k.name !== 'string' || !KEY_NAME.test(k.name))
      throw new UpstreamError('Google IAM keys.list answered with a bad key.', 'IAM_BAD_KEY');
    return { name: k.name, userManaged: k.keyType === undefined || k.keyType === 'USER_MANAGED' };
  });
}
