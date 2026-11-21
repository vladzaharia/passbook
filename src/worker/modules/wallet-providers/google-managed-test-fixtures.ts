// A stand-in for Google (Wallet API, OAuth and IAM) behind `setManagedDeps`: no real call is ever made.
import { vi } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createSafeFetch, type SafeFetch } from '../../platform/safe-fetch.ts';
import { setManagedDeps } from './google-managed-deps.ts';

export const SA_EMAIL = 'wallet@example-project.iam.gserviceaccount.com';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface GoogleStub {
  calls: string[];
  /** Issuers the service account can see: id to name. */
  issuers: Map<string, string>;
  aggregator: boolean;
  /** The next N token exchanges answer 400. */
  failTokenTimes: number;
  /** Owner emails by issuer id (`permissions.get`). */
  owners: Map<string, string[]>;
  /** Runs once, on the first token exchange after a key was created. */
  onToken: (() => Promise<void>) | null;
  /** The next N `keys.delete` calls answer 503. */
  failDeleteTimes: number;
  /** After `keys.create`, the next N token exchanges answer 400 (the new key does not work yet). */
  failTokenAfterCreate: number;
  /** Key names the service account holds. */
  keys: string[];
  /** Private keys handed out by `keys.create`, oldest first. */
  created: string[];
  /** The next `issuer.insert` is answered with this status instead. */
  insertStatus: number | null;
  /** The next `issuer.list` fails with this status. */
  listStatus: number | null;
}

let nextKey = 100;
let nextIssuer = 7_000_000_000;

export function installGoogleStub(): GoogleStub {
  const stub: GoogleStub = {
    calls: [],
    issuers: new Map(),
    aggregator: true,
    failTokenTimes: 0,
    failTokenAfterCreate: 0,
    owners: new Map(),
    failDeleteTimes: 0,
    onToken: null,
    keys: [],
    created: [],
    insertStatus: null,
    listStatus: null,
  };
  const keyName = (id: number) => `projects/example-project/serviceAccounts/${SA_EMAIL}/keys/${id}`;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    stub.calls.push(`${method} ${url.hostname}${url.pathname}`);
    if (url.hostname === 'oauth2.googleapis.com') {
      const hook = stub.onToken;
      if (hook && stub.created.length > 0) {
        stub.onToken = null;
        await hook();
      }
      if (stub.failTokenTimes > 0) {
        stub.failTokenTimes -= 1;
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({ access_token: 'ya29.stub', token_type: 'Bearer', expires_in: 3600 });
    }
    if (url.hostname === 'walletobjects.googleapis.com') {
      const owned = url.pathname.split('/permissions/')[1];
      if (owned !== undefined) {
        if (!stub.issuers.has(owned)) return json({}, 403);
        return json({
          permissions: (stub.owners.get(owned) ?? []).map((emailAddress) => ({
            emailAddress,
            role: 'OWNER',
          })),
        });
      }
      const id = url.pathname.split('/issuer/')[1];
      if (method === 'GET' && id === undefined) {
        if (stub.listStatus) return json({}, stub.listStatus);
        return json({
          resources: [...stub.issuers].map(([issuerId, name]) => ({ issuerId, name })),
        });
      }
      if (method === 'GET') {
        const name = stub.issuers.get(id ?? '');
        return name === undefined ? json({}, 403) : json({ issuerId: id, name });
      }
      if (method === 'POST') {
        if (stub.insertStatus) return json({}, stub.insertStatus);
        if (!stub.aggregator) return json({}, 403);
        nextIssuer += 1;
        const issuerId = String(nextIssuer);
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        stub.issuers.set(issuerId, name);
        return json({ issuerId, name });
      }
    }
    if (url.hostname === 'iam.googleapis.com') {
      if (method === 'POST') {
        nextKey += 1;
        const id = nextKey;
        const identity = await createFixtureIdentity();
        stub.keys.push(keyName(id));
        stub.created.push(identity.privateKey);
        stub.failTokenTimes = stub.failTokenAfterCreate;
        return json({
          name: keyName(id),
          privateKeyData: btoa(
            JSON.stringify({ private_key: identity.privateKey, client_email: SA_EMAIL }),
          ),
        });
      }
      if (method === 'DELETE') {
        if (stub.failDeleteTimes > 0) {
          stub.failDeleteTimes -= 1;
          return json({}, 503);
        }
        const name = decodeURIComponent(url.pathname.replace('/v1/', ''));
        if (!stub.keys.includes(name)) return json({}, 404);
        stub.keys = stub.keys.filter((k) => k !== name);
        return json({});
      }
      return json({ keys: stub.keys.map((name) => ({ name, keyType: 'USER_MANAGED' })) });
    }
    return json({}, 404);
  };
  const safe: SafeFetch = createSafeFetch({
    fetchImpl: fetchImpl as typeof fetch,
    resolver: { resolve: async () => ['142.250.80.46'] },
  });
  setManagedDeps({
    fetcher: () => fetchImpl as typeof fetch,
    iam: () => safe,
    wait: async () => {},
  });
  return stub;
}

/** An env whose queue records what is sent. */
export const withQueue = <T extends { JOBS: unknown }>(e: T) => {
  const sent: unknown[] = [];
  return {
    env: {
      ...e,
      JOBS: { send: vi.fn(async (m: unknown) => void sent.push(m)), sendBatch: vi.fn() },
    },
    sent,
  };
};

export const keyNameOf = (id: number) =>
  `projects/example-project/serviceAccounts/${SA_EMAIL}/keys/${id}`;
