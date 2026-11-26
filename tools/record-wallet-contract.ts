// Owner-run: records what Google and Samsung really answer, in demo or testing mode, as scrubbed fixtures under
// test/fixtures/wallets/{google,samsung}/. Tests and CI never run this against a provider.
//
//   node tools/record-wallet-contract.ts google  --issuer <issuer id> [--types generic,loyalty] [--key <file>] [--yes-real-provider]
//   node tools/record-wallet-contract.ts samsung --card <card id> --ref <ref id> [--cc2 US] [--types loyalty] [--key <file>] [--yes-real-provider]
//   node tools/record-wallet-contract.ts scrub-capture <saved request json> --name <fixture name>
//
// Without --yes-real-provider it is a dry run: the plan is printed, no key is read and nothing is sent. Keys are read
// from .secrets/ and never printed. Every body is scrubbed, then checked again; a fixture that still looks like it
// holds a secret is not written. Samsung's Get Card Data and Send Card State are Samsung calling the Worker:
// save one request as JSON ({method, path, headers, body}) and use scrub-capture.
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GOOGLE_API,
  GOOGLE_RECORD_TYPES,
  type GoogleRecordType,
  googleCalls,
  type PlannedCall,
  SAMSUNG_API,
  SAMSUNG_RECORD_TYPES,
  type SamsungRecordType,
  samsungCalls,
} from './lib/wallet-contract-plan.ts';
import {
  leaks,
  newScrubContext,
  scrubHeaders,
  scrubString,
  scrubValue,
} from './lib/wallet-scrub.ts';
import { accessToken } from './record-google-messages.ts';

const root = resolve(import.meta.dirname, '..');
const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export interface RecordedCall {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export interface ContractOptions {
  fetcher: typeof fetch;
  base: string;
  calls: PlannedCall[];
  /** Headers for one call (the token); never written out. */
  headers: (call: PlannedCall) => Record<string, string>;
  /** Literal ids that must not survive in any fixture. */
  literals?: string[];
  /** Where fixtures are written; absent: returned only. */
  out?: string;
  dryRun: boolean;
}

function finish(serialized: string, literals: string[]): string {
  let text = serialized;
  literals.forEach((lit, i) => {
    if (lit) text = text.split(lit).join(`<ref-${i + 1}>`);
  });
  return text;
}

/** Sends each call in order (unless dryRun), scrubs what came back and writes one fixture per call. */
export async function recordContract(o: ContractOptions): Promise<RecordedCall[]> {
  const ctx = newScrubContext();
  const literals = o.literals ?? [];
  const done: RecordedCall[] = [];
  for (const call of o.calls) {
    const request = {
      method: call.method,
      path: scrubString(finish(call.path, literals), ctx),
      ...(call.body === undefined ? {} : { body: scrubValue(call.body, ctx) }),
    };
    if (o.dryRun) {
      done.push({ name: call.name, request, response: { status: 0, headers: {}, body: null } });
      continue;
    }
    const res = await o.fetcher(`${o.base}${call.path}`, {
      method: call.method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...o.headers(call) },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-JSON answer is kept as scrubbed text.
    }
    done.push({
      name: call.name,
      request,
      response: {
        status: res.status,
        headers: scrubHeaders(res.headers),
        body: scrubValue(parsed, ctx),
      },
    });
  }
  if (o.out && !o.dryRun) {
    mkdirSync(o.out, { recursive: true });
    for (const rec of done) {
      const text = `${finish(JSON.stringify(rec, null, 2), literals)}\n`;
      const found = leaks(text);
      if (found.length)
        throw new Error(`Not written: ${rec.name} still holds ${found.join(', ')}.`);
      writeFileSync(resolve(o.out, `${rec.name}.json`), text);
    }
  }
  return done;
}

/** Samsung's v3 REST token: a JWS over the API method and path (samsung-token.ts has the Worker's copy). */
export function samsungAuth(
  key: { partnerId: string; certificateId: string; privateKeyPem: string },
  call: PlannedCall,
  now = Date.now(),
): string {
  const head = {
    alg: 'RS256',
    cty: 'AUTH',
    ver: '3',
    certificateId: key.certificateId,
    partnerId: key.partnerId,
    utc: now,
  };
  const input = `${b64u(JSON.stringify(head))}.${b64u(JSON.stringify({ API: { method: call.method, path: call.path } }))}`;
  return `${input}.${b64u(createSign('RSA-SHA256').update(input).sign(key.privateKeyPem))}`;
}

/** A request Samsung made to the Worker, saved by the owner: scrub it into a fixture. */
export function scrubCapture(raw: string): unknown {
  const v = JSON.parse(raw) as {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  const ctx = newScrubContext();
  return {
    method: v.method,
    path: scrubString(v.path ?? '', ctx),
    headers: scrubHeaders(v.headers ?? {}),
    body: scrubValue(v.body, ctx),
  };
}

const csv = <T extends string>(value: string | undefined, all: readonly T[]): T[] => {
  const asked = (value ?? '').split(',').filter(Boolean);
  const bad = asked.filter((t) => !all.includes(t as T));
  if (bad.length) throw new Error(`Unknown type: ${bad.join(', ')}. Use ${all.join(', ')}.`);
  return (asked.length ? asked : all) as T[];
};

function report(calls: RecordedCall[], real: boolean) {
  for (const c of calls)
    console.log(
      real
        ? `${c.name}: ${c.response.status}`
        : `${c.request.method} ${c.request.path}  -> ${c.name}.json`,
    );
}

async function main(argv: string[]) {
  const arg = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const [command] = argv;
  const real = argv.includes('--yes-real-provider');
  const readKey = (fallback: string) =>
    JSON.parse(readFileSync(resolve(root, arg('key') ?? fallback), 'utf8')) as Record<
      string,
      string
    >;
  if (command === 'scrub-capture') {
    const file = argv[1];
    const name = arg('name');
    if (!file || !name || !/^[\w-]+$/.test(name))
      throw new Error('Pass <file> and --name <fixture name>.');
    const out = resolve(root, 'test/fixtures/wallets/samsung', `${name}.json`);
    const text = `${JSON.stringify(scrubCapture(readFileSync(resolve(file), 'utf8')), null, 2)}\n`;
    const found = leaks(text);
    if (found.length) throw new Error(`Not written: the capture still holds ${found.join(', ')}.`);
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, text);
    console.log(`Wrote ${out}`);
    return;
  }
  if (command === 'google') {
    const issuer = arg('issuer');
    if (!issuer || !/^\d{6,}$/.test(issuer)) throw new Error('Pass --issuer <numeric issuer id>.');
    const types = csv<GoogleRecordType>(arg('types'), GOOGLE_RECORD_TYPES);
    const calls = types.flatMap((t) => googleCalls(issuer, t, `rec-${Date.now().toString(36)}`));
    const token = real
      ? await accessToken(readKey('.secrets/google-demo-service-account.json') as never, fetch)
      : '';
    const done = await recordContract({
      fetcher: fetch,
      base: GOOGLE_API,
      calls,
      headers: () => ({ authorization: `Bearer ${token}` }),
      literals: [issuer],
      out: resolve(root, 'test/fixtures/wallets/google'),
      dryRun: !real,
    });
    report(done, real);
    return;
  }
  if (command === 'samsung') {
    const card = arg('card');
    const ref = arg('ref');
    if (!card || !ref) throw new Error('Pass --card <card id> and --ref <ref id>.');
    const types = csv<SamsungRecordType>(arg('types'), SAMSUNG_RECORD_TYPES);
    const calls = types.flatMap((t) => samsungCalls(arg('cc2') ?? 'US', card, t, ref));
    const key = real ? readKey('.secrets/samsung-testing-partner.json') : null;
    const done = await recordContract({
      fetcher: fetch,
      base: SAMSUNG_API,
      calls,
      headers: (call) =>
        key
          ? {
              authorization: `Bearer ${samsungAuth(key as never, call)}`,
              'x-smcs-partner-id': key.partnerId as string,
              'x-request-id': 'rec',
            }
          : ({} as Record<string, string>),
      literals: [card, ref, ...(key ? [key.partnerId as string] : [])],
      out: resolve(root, 'test/fixtures/wallets/samsung'),
      dryRun: !real,
    });
    report(done, real);
    return;
  }
  throw new Error('Use google, samsung or scrub-capture. See the header of this file.');
}

if (process.argv[1] === import.meta.filename) {
  const argv = process.argv.slice(2);
  await main(argv);
  if (!argv.includes('--yes-real-provider') && argv[0] !== 'scrub-capture')
    console.log(
      'Dry run: nothing sent. Add --yes-real-provider to call the provider with the demo or testing key.',
    );
}
