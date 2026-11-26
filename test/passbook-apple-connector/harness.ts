import { env } from 'cloudflare:workers';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import migration from '../../workers/passbook-apple-connector/migrations/0001_provisioner.sql?raw';
import guards from '../../workers/passbook-apple-connector/migrations/0002_cert_guards.sql?raw';
import { createApi } from '../../workers/passbook-apple-connector/src/api.ts';
import type { Deps } from '../../workers/passbook-apple-connector/src/asc-http.ts';
import type { ProvisionerEnv } from '../../workers/passbook-apple-connector/src/types.ts';

export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])) as CryptoKeyPair;
const pkcs8 = new Uint8Array(
  (await crypto.subtle.exportKey('pkcs8', ec.privateKey)) as ArrayBuffer,
);
export const P8_BODY = btoa(String.fromCharCode(...pkcs8));
export const ascPublicKey = ec.publicKey;
const P8 = `-----BEGIN PRIVATE KEY-----\n${P8_BODY}\n-----END PRIVATE KEY-----`;

export const provisionerEnv: ProvisionerEnv = {
  DB: env.DB,
  ASC_KEY_P8: P8,
  ASC_KEY_ID: 'KEYID12345',
  ASC_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
};

/** The provisioner's tables in the worker project's D1. The setup drops triggers it did not migrate, so each test recreates all. */
export async function resetLedger(): Promise<void> {
  await env.DB.prepare('DROP TABLE IF EXISTS asc_calls').run();
  await env.DB.prepare('DROP TABLE IF EXISTS asc_certificates').run();
  await env.DB.prepare('DROP TABLE IF EXISTS asc_revocations').run();
  await env.DB.prepare('DROP TABLE IF EXISTS asc_pass_types').run();
  const statements = `${migration}\n\n${guards}`
    .split('\n')
    .filter((l) => !l.startsWith('--'))
    .join('\n')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await env.DB.prepare(sql).run();
}

export interface Seen {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}
export type Handler = (seen: Seen) => {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export function stubApple(handler: Handler, clock = { now: NOW }) {
  const seen: Seen[] = [];
  const deps: Deps = {
    now: () => clock.now,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const entry: Seen = {
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        auth: new Headers(init?.headers).get('authorization') ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(entry);
      const out = handler(entry);
      const status = out.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), {
        status,
        headers: out.headers ?? { 'x-request-id': `req-${seen.length}` },
      });
    },
  };
  return { seen, deps, api: createApi(provisionerEnv, deps), clock };
}

const rsa = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;

export async function makeCsr(cn: string, keys: CryptoKeyPair = rsa): Promise<Uint8Array> {
  const csr = new pkijs.CertificationRequest();
  csr.version = 0;
  csr.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
  await csr.subjectPublicKeyInfo.importKey(keys.publicKey);
  await csr.sign(keys.privateKey, 'SHA-256');
  return new Uint8Array(csr.toSchema().toBER());
}

export const ecKeys = ec;

export async function seedPassType(identifier: string, ascId: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO asc_pass_types (identifier, asc_id, name, source, created_at) VALUES (?, ?, NULL, 'seeded', ?)",
  )
    .bind(identifier, ascId, NOW)
    .run();
}

export async function ledger() {
  const { results } = await env.DB.prepare('SELECT * FROM asc_calls ORDER BY id').all<
    Record<string, unknown>
  >();
  return results;
}

/** A certificate the provisioner ordered `ageMs` before NOW; `active` marks it reported active. */
export async function seedCertificate(
  certId: string,
  passTypeAscId: string,
  ageMs: number,
  active: boolean,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO asc_certificates (cert_id, pass_type_asc_id, ordered_at, activated_at) VALUES (?, ?, ?, ?)',
  )
    .bind(certId, passTypeAscId, NOW - ageMs, active ? NOW - ageMs : null)
    .run();
}
