// Owner-run: records what Google's object addMessage really answers, in demo mode, for the fixtures GM3 pins
// (docs/design/wallet-providers/google-messages.md section 12, V1 to V5). Never run by tests or CI against Google.
//
//   node tools/record-google-messages.ts --objects <id1>,<id2> [--key .secrets/<service-account>.json] [--yes-real-google]
//
// Both objects are saved test objects of one class in the demo issuer. Without --yes-real-google nothing is sent.
// The key is read from .secrets/ and never printed. Responses are scrubbed (ids, issuer, tokens) before they are
// written to test/fixtures/wallets/google/. V6 (the Pixel notification) is a manual note, printed at the end.
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'https://walletobjects.googleapis.com/walletobjects/v1/genericObject';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'test/fixtures/wallets/google');

type Fetcher = typeof fetch;
interface Recorded {
  step: string;
  status: number;
  body: unknown;
}

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export async function accessToken(key: { client_email: string; private_key: string }, f: Fetcher) {
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 300,
    }),
  )}`;
  const assertion = `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(key.private_key))}`;
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const { access_token: token } = (await res.json()) as { access_token?: string };
  if (!token) throw new Error(`Token exchange failed (${res.status}).`);
  return token;
}

/**
 * Only what the fixtures need: the status, the error, and the id and type of each message held. Object content
 * (barcodes, text modules, links, images) is dropped, and any URL, id, issuer number or address left is scrubbed.
 */
export function scrub(value: unknown): unknown {
  const v = (value ?? {}) as {
    error?: unknown;
    resource?: { messages?: { id?: unknown; messageType?: unknown }[] };
  };
  const kept: Record<string, unknown> = {};
  if (v.error !== undefined) kept.error = v.error;
  if (Array.isArray(v.resource?.messages))
    kept.messages = v.resource.messages.map((m) => ({ id: m.id, messageType: m.messageType }));
  if (typeof value === 'string') kept.text = value.slice(0, 500);
  return JSON.parse(
    JSON.stringify(kept)
      .replace(/https?:\/\/[^\s"\\]+/g, '<url>')
      .replace(/\b\d{10,}(\.[\w-]+)?/g, '<issuer>$1')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'),
  );
}

export interface RecordOptions {
  fetcher: Fetcher;
  token: string;
  objects: [string, string];
  /** Where the answers are written; absent: returned only. */
  out?: string;
}

const message = (id: string, messageType: 'TEXT' | 'TEXT_AND_NOTIFY') => ({
  message: { id, header: 'PassBook test', body: `Recorded ${id}`, messageType },
});

/** V1 to V5, in order. Each step records the status and the scrubbed body Google answered. */
export async function recordGoogleMessages(o: RecordOptions): Promise<Recorded[]> {
  const headers = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' };
  const url = (object: string, suffix = '') => `${API}/${encodeURIComponent(object)}${suffix}`;
  const done: Recorded[] = [];
  const call = async (step: string, u: string, method: string, body?: unknown) => {
    const res = await o.fetcher(u, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON body is kept as text, scrubbed.
    }
    done.push({ step, status: res.status, body: scrub(parsed) });
    return res.status;
  };
  const [first, second] = o.objects;
  // V1: four notifying messages within the hour; the fourth is the quota fixture.
  for (const n of [1, 2, 3, 4])
    await call(
      `V1 notify ${n}`,
      url(first, '/addMessage'),
      'POST',
      message(`rec-n${n}`, 'TEXT_AND_NOTIFY'),
    );
  // V2: another object of the class must still notify (the limit is per object).
  await call(
    'V2 other object',
    url(second, '/addMessage'),
    'POST',
    message('rec-o1', 'TEXT_AND_NOTIFY'),
  );
  // V3: the same messages as TEXT in a PATCH. Watch the device: it must not notify or highlight again.
  await call('V3 patch as text', url(first), 'PATCH', {
    messages: [1, 2, 3].map((n) => ({ ...message(`rec-n${n}`, 'TEXT').message })),
  });
  // V4: an id already on the object; record whether Google duplicates it (informational).
  await call('V4 repeated id', url(first, '/addMessage'), 'POST', message('rec-n1', 'TEXT'));
  // V5: keep adding TEXT until the refusal; this pins the per-object cap.
  for (let n = 1; n <= 12; n++)
    if (
      (await call(
        `V5 text ${n}`,
        url(first, '/addMessage'),
        'POST',
        message(`rec-t${n}`, 'TEXT'),
      )) >= 400
    )
      break;
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    const quota = done.find((r) => r.step === 'V1 notify 4');
    const ok = done.find((r) => r.step === 'V1 notify 1');
    writeFileSync(resolve(o.out, 'add-message-quota.json'), `${JSON.stringify(quota, null, 2)}\n`);
    writeFileSync(resolve(o.out, 'add-message-ok.json'), `${JSON.stringify(ok, null, 2)}\n`);
    writeFileSync(resolve(o.out, 'add-message-steps.json'), `${JSON.stringify(done, null, 2)}\n`);
  }
  return done;
}

if (process.argv[1] === import.meta.filename) {
  const arg = (name: string) => {
    const at = process.argv.indexOf(`--${name}`);
    return at < 0 ? undefined : process.argv[at + 1];
  };
  const objects = (arg('objects') ?? '').split(',').filter(Boolean);
  if (objects.length !== 2)
    throw new Error('Pass --objects <id1>,<id2> (two saved demo objects of one class).');
  if (!process.argv.includes('--yes-real-google')) {
    console.log('Dry run: nothing sent. Add --yes-real-google to call Google with the demo key.');
    process.exit(0);
  }
  const key = JSON.parse(
    readFileSync(resolve(root, arg('key') ?? '.secrets/google-demo-service-account.json'), 'utf8'),
  ) as { client_email: string; private_key: string };
  const token = await accessToken(key, fetch);
  const steps = await recordGoogleMessages({
    fetcher: fetch,
    token,
    objects: [objects[0] as string, objects[1] as string],
    out: outDir,
  });
  for (const s of steps) console.log(`${s.step}: ${s.status}`);
  console.log(
    'V6 (by hand, on a Pixel): note what the notification says and what "View message" shows, for the device runbook.',
  );
}
