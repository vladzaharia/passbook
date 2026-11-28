import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import demo from '../../connectors/demo/index.ts';
import httpJson from '../../connectors/http-json/index.ts';
import { connectors, defineRegistry } from '../../connectors/registry.ts';
import { type AnyConnector, ConnectorError, declareCapabilities } from '../../connectors/types.ts';
import { setDeps } from './deps.ts';
import { getConnection } from './repo.ts';
import { prepare } from './runtime.ts';
import * as service from './service.ts';
import { unsavedContext } from './test-config.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
let dns: string[];
beforeEach(async () => {
  kit = await makeKit();
  dns = [];
  setDeps({
    resolver: {
      resolve: async (host) => {
        dns.push(host);
        return ['93.184.216.34'];
      },
    },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
});
afterEach(() => vi.restoreAllMocks());

const upload = defineRegistry([
  {
    ...demo,
    capabilities: declareCapabilities({
      read: { fetch: true, list: true, delta: true, upload: true },
      auth: 'none',
    }),
  },
]).list()[0] as AnyConnector;

async function rowOf(id: string) {
  const row = await getConnection(kit.env.DB, id);
  if (!row) throw new Error(`missing connection ${id}`);
  return row;
}

async function rejection(promise: Promise<unknown>): Promise<ConnectorError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ConnectorError)) throw new Error('expected a ConnectorError');
  return error;
}

describe('prepare', () => {
  it('pins an http-json connection to its base origin, refusing others before DNS', async () => {
    const created = await service.create(kit.sctx, kit.actor, {
      orgId: kit.org.id,
      connectorType: 'http-json',
      name: 'API',
      config: { baseUrl: 'https://api.example.com/v1' },
      mode: 'poll',
    } as Parameters<typeof service.create>[2]);
    const { cc } = await prepare(kit.sctx, await rowOf(created.id));
    dns.length = 0;
    const refused = await rejection(cc.fetch('https://evil.example.net/v1/m-1'));
    expect(refused).toMatchObject({ code: 'CONFIG', permanent: true, reason: 'OFF_ORIGIN' });
    expect(dns).toEqual([]);
    expect((await cc.fetch('https://api.example.com/v1/m-1')).status).toBe(200);
    expect(dns).toEqual(['api.example.com']);
    expect(cc.files).toBeUndefined();
  });

  it('gives a demo connection no network and no files', async () => {
    const { cc } = await prepare(kit.sctx, await rowOf((await createDemo(kit)).id));
    expect((await rejection(cc.fetch('https://api.example.com/'))).reason).toBe('OFF_ORIGIN');
    expect(dns).toEqual([]);
    expect(cc.files).toBeUndefined();
  });

  it('gives an upload connector a files port over its own revisions: none yet, and a foreign file refuses as CONFIG', async () => {
    const row = await rowOf((await createDemo(kit)).id);
    const original = connectors.get.bind(connectors);
    vi.spyOn(connectors, 'get').mockImplementation((type) =>
      type === 'demo' ? upload : original(type),
    );
    const { cc } = await prepare(kit.sctx, row);
    const files = cc.files;
    if (!files) throw new Error('expected a files port');
    expect(await files.current()).toBeNull();
    expect(await files.previous(3)).toEqual([]);
    for (const read of [files.page('f1', 0), files.refs('f1'), files.find('f1', 'm-001')]) {
      expect(await rejection(read)).toMatchObject({ code: 'CONFIG', permanent: true });
    }
  });
});

describe('unsavedContext', () => {
  it('pins an unsaved http-json config to its base origin and binds no files', async () => {
    const config = httpJson.configSchema.parse({ baseUrl: 'https://api.example.com/v1' });
    const cc = unsavedContext(kit.sctx, httpJson, kit.org.id, config, {});
    expect((await rejection(cc.fetch('https://evil.example.net/'))).reason).toBe('OFF_ORIGIN');
    expect(dns).toEqual([]);
    expect((await cc.fetch('https://api.example.com/v1/m-1')).status).toBe(200);
    expect(cc.files).toBeUndefined();
  });

  it('binds an upload connector to its draft, with or without a file id', async () => {
    const config = upload.configSchema.parse({});
    const named = unsavedContext(
      kit.sctx,
      upload,
      kit.org.id,
      config,
      undefined,
      '01900000-0000-7000-8000-00000000f11e',
    ).files;
    if (!named) throw new Error('expected a files port');
    expect((await rejection(named.current())).code).toBe('CONFIG');
    const bare = unsavedContext(kit.sctx, upload, kit.org.id, config, undefined).files;
    if (!bare) throw new Error('expected a files port');
    expect(await bare.current()).toBeNull();
  });
});
