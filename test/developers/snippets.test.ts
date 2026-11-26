/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import openapi from '../../docs/api/openapi.v1.json';
import { validateAgainst } from '../helpers/openapi-validate.ts';
import { type Call, kit, snippetWorld } from './snippet-world.ts';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The snippets import the published name; here it is the source.
vi.mock('@passbook/sdk', () => import('../../sdk/typescript/src/index.ts'));
// Workerd has no files: the uploads' `image.png` is one PNG pixel.
vi.mock('node:fs/promises', () => ({
  readFile: async () => Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0)),
}));

const ts = import.meta.glob('../../docs/developers/snippets/generated/ts/*.ts');
const guideRows = Object.values(
  import.meta.glob<Guide[]>('../../docs/developers/snippets/guides/index.*.json', {
    import: 'default',
    eager: true,
  }),
).flat();
const guideTs = import.meta.glob('../../docs/developers/snippets/guides/*.ts');
const guideSh = import.meta.glob<string>('../../docs/developers/snippets/guides/*.sh', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const curl = import.meta.glob<string>('../../docs/developers/snippets/generated/curl/*.sh', {
  query: '?raw',
  import: 'default',
  eager: true,
});

type Dict = Record<string, unknown>;
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

const name = (path: string) =>
  path
    .split('/')
    .at(-1)
    ?.replace(/\.(ts|sh)$/, '') ?? path;

/** Refusals that say the example's entity does not exist in this organization, not that the snippet is wrong. */
const ABSENT = new Set(['DNS_FAILED', 'VISITOR_HOST_UNKNOWN']);

/** A snippet ran if the API answered it: the key was accepted, the route exists, the body was valid. */
const reached = (c: Call) =>
  ABSENT.has(c.code ?? '') || (c.status < 500 && ![400, 401, 403, 405, 422].includes(c.status));

/** The org's brand, zones, tag types and saved mappings belong to it, not a mode: a test key may not write them, and the world's key is a test key. */
const LIVE_ONLY = new Map([
  ['scan-zones.postScanZones', 'SCAN_ZONE_LIVE_ONLY'],
  ['brand.patchBrand', 'MODE_LIVE_REQUIRED'],
  ['brand.putBrandWebLogo', 'MODE_LIVE_REQUIRED'],
  ['brand.deleteBrandWebLogo', 'MODE_LIVE_REQUIRED'],
  ['nfc-tags.postNfcTagTypes', 'MODE_LIVE_REQUIRED'],
  ['pass-imports.putPassImportsMappings', 'MODE_LIVE_REQUIRED'],
  ['pass-imports.deletePassImportsMappings', 'MODE_LIVE_REQUIRED'],
  ['pass-setup.patchOrgsByOrgIdPassSetup', 'MODE_LIVE_REQUIRED'],
  ['pass-setup.postOrgsByOrgIdBrandAssets', 'MODE_LIVE_REQUIRED'],
]);

/** Google and Samsung ship dark: the reissue route answers WALLET_PROVIDER_DISABLED until a provider is released. */
const DARK_PROVIDER = new Set(['wallet-providers.postWalletProvidersReissue']);

/** One line per call the API refused. */
function failures(id: string, calls: Call[]): string[] {
  if (calls.length === 0) return [`${id}: made no request`];
  return calls
    .filter(
      (c) =>
        !reached(c) &&
        !(LIVE_ONLY.get(id) === c.code) &&
        !(DARK_PROVIDER.has(id) && c.code === 'WALLET_PROVIDER_DISABLED'),
    )
    .map((c) => `${id}: ${c.method} ${c.path} ${c.status} ${c.code} ${c.detail ?? ''}`);
}

/** The request a curl snippet makes, as `fetch` arguments. */
function parseCurl(text: string, secret: string) {
  const line = text.replaceAll('\\\n', ' ');
  const method = /-X (\w+)/.exec(line)?.[1] ?? 'GET';
  const url = /"(https:[^"]+)"/.exec(line)?.[1] ?? '';
  const headers: Record<string, string> = {};
  for (const m of line.matchAll(/-H "([^:]+): ([^"]+)"/g))
    headers[m[1] ?? ''] = (m[2] ?? '')
      .replace('$PASSBOOK_KEY', secret)
      .replace('$(date +%s)-$RANDOM', crypto.randomUUID());
  const body = /-d '([\s\S]*)'\s*$/.exec(line)?.[1];
  return { method, url, headers, body, binary: line.includes('--data-binary') };
}

/** What a reader's earlier answers give a hand-written curl snippet: `$PASS_ID`, and the pass's current `$VERSION` for `If-Match`. */
async function withVars(
  text: string,
  world: { passId: string; secret: string; fetch: typeof fetch },
): Promise<string> {
  let out = text.replaceAll('$PASS_ID', world.passId);
  if (out.includes('$VERSION')) {
    const res = await world.fetch(`https://passbook.mobile/api/v1/passes/${world.passId}`, {
      headers: { authorization: `Bearer ${world.secret}` },
    });
    out = out.replaceAll('$VERSION', String(((await res.json()) as { version: number }).version));
  }
  return out;
}

describe('generated snippets', () => {
  it('has one TypeScript and one curl snippet per operation', () => {
    expect(Object.keys(ts).map(name).sort()).toEqual(Object.keys(curl).map(name).sort());
    expect(Object.keys(ts).length).toBeGreaterThan(150);
  });

  it('runs every TypeScript snippet', async () => {
    const world = await snippetWorld(await kit());
    process.env.PASSBOOK_KEY = world.secret;
    vi.stubGlobal('fetch', world.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const problems: string[] = [];
    for (const [path, load] of Object.entries(ts)) {
      world.calls.length = 0;
      await load().catch(() => undefined);
      problems.push(...failures(name(path), world.calls));
    }
    expect(problems).toEqual([]);
  });

  it('runs every curl snippet', async () => {
    const world = await snippetWorld(await kit());
    const problems: string[] = [];
    for (const [path, text] of Object.entries(curl)) {
      world.calls.length = 0;
      const req = parseCurl(text, world.secret);
      const body = req.binary ? PNG : req.body;
      await world.fetch(req.url, { method: req.method, headers: req.headers, body });
      problems.push(...failures(name(path), world.calls));
    }
    expect(problems).toEqual([]);
  });

  it('sends bodies the contract accepts', () => {
    // The export leaves a regex flag in some patterns (`...$/i`), which no value can match.
    const contract = JSON.parse(JSON.stringify(openapi).replaceAll('$/i"', '$"')) as object;
    const ops = new Map<string, unknown>();
    for (const item of Object.values(openapi.paths))
      for (const op of Object.values(item) as Dict[]) {
        const schema = (op.requestBody as Dict | undefined)?.content as Dict | undefined;
        if (typeof op.operationId === 'string')
          ops.set(op.operationId, (schema?.['application/json'] as Dict | undefined)?.schema);
      }
    let checked = 0;
    for (const [path, text] of Object.entries(curl)) {
      const body = parseCurl(text, 'key').body;
      const schema = ops.get(name(path));
      if (body === undefined || schema === undefined) continue;
      checked++;
      expect(validateAgainst(contract, schema as object, JSON.parse(body)), name(path)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(50);
  });
});

interface Guide {
  id: string;
  title: string;
  guide: string;
  ops: string[];
  files: { ts: string; curl?: string };
  sandbox?: string;
  expect?: 'fails' | 'handler';
}
const hand = guideRows;

/** Every call must answer 2xx, except the code the row says a sandbox answers (`sandbox`) or `fails` for a snippet that shows an error. */
function handFailures(g: Guide, calls: Call[]): string[] {
  if (calls.length === 0) return [`${g.id}: made no request`];
  const line = (c: Call) =>
    `${g.id}: ${c.method} ${c.path} ${c.status} ${c.code} ${c.detail ?? ''}`;
  if (g.expect === 'fails') return calls.filter((c) => c.status < 400 || c.status >= 500).map(line);
  // The webhook host check's DNS-over-HTTPS lookup goes through the same fetch; it is not the snippet's call.
  return calls
    .filter((c) => c.status >= 300 && c.code !== g.sandbox && c.path !== '/dns-query')
    .map(line);
}

describe('guide snippets', () => {
  it('lists about 25, each with files and real operations', () => {
    expect(hand.length).toBeGreaterThanOrEqual(24);
    const known = new Set<string>();
    for (const item of Object.values(openapi.paths))
      for (const op of Object.values(item) as Dict[]) known.add(String(op.operationId));
    for (const g of hand) {
      expect(guideTs[`../../docs/developers/snippets/guides/${g.files.ts}`], g.id).toBeDefined();
      if (g.files.curl)
        expect(
          guideSh[`../../docs/developers/snippets/guides/${g.files.curl}`],
          g.id,
        ).toBeDefined();
      for (const op of g.ops) expect(known.has(op), `${g.id}: ${op}`).toBe(true);
    }
  });

  it('runs every TypeScript and curl snippet', async () => {
    const world = await snippetWorld(await kit());
    process.env.PASSBOOK_KEY = world.secret;
    vi.stubGlobal('fetch', world.fetch);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const problems: string[] = [];
    for (const g of hand) {
      if (g.expect === 'handler') continue;
      world.calls.length = 0;
      // A thrown ApiError is the call's own refusal, already in `calls`.
      await guideTs[`../../docs/developers/snippets/guides/${g.files.ts}`]?.().catch(
        () => undefined,
      );
      problems.push(...handFailures(g, world.calls));
      const sh = g.files.curl
        ? guideSh[`../../docs/developers/snippets/guides/${g.files.curl}`]
        : undefined;
      if (sh === undefined) continue;
      const text = await withVars(sh, world);
      world.calls.length = 0;
      const req = parseCurl(text, world.secret);
      await world.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      problems.push(...handFailures(g, world.calls).map((p) => `${p} (curl)`));
    }
    expect(problems).toEqual([]);
  });

  it('verifies a signed webhook and refuses a forged one', async () => {
    const secret = 'whsec_test';
    process.env.PASSBOOK_WEBHOOK_SECRET = secret;
    const mod = (await guideTs['../../docs/developers/snippets/guides/verify-webhook.ts']?.()) as {
      handle(request: Request): Promise<Response>;
    };
    const body = JSON.stringify({ id: 'evt_1', type: 'pass.issued', pass: { id: 'p1' } });
    const at = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${at}.${body}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const send = (signature: string) =>
      mod.handle(
        new Request('https://example.com/hook', {
          method: 'POST',
          body,
          headers: { 'x-passbook-timestamp': at, 'x-passbook-signature': signature },
        }),
      );
    expect((await send(`v1=${hex}`)).status).toBe(200);
    expect((await send(`v1=${'0'.repeat(64)}`)).status).toBe(400);
  });
});
