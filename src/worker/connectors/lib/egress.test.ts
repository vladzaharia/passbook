import { describe, expect, it } from 'vitest';
import { createSafeFetch, type SafeFetch } from '../../platform/safe-fetch.ts';
import csvUrl from '../csv-url/index.ts';
import httpJson from '../http-json/index.ts';
import { connectors } from '../registry.ts';
import { type AnyConnector, ConnectorError } from '../types.ts';
import { egressFetch, offOrigin, pinFetch } from './egress.ts';

/** A safe fetch whose DNS and network are recorded, answering 200 (or a redirect for `redirects`). */
function harness(redirects: Record<string, string> = {}) {
  const dns: string[] = [];
  const sent: string[] = [];
  const safe = createSafeFetch({
    resolver: {
      resolve: async (host) => {
        dns.push(host);
        return ['93.184.216.34'];
      },
    },
    fetchImpl: async (input) => {
      const url = String(input);
      sent.push(url);
      const to = redirects[url];
      return to
        ? new Response(null, { status: 302, headers: { location: to } })
        : new Response('{}', { status: 200 });
    },
    maxRedirects: 3,
  });
  return { safe, dns, sent };
}

async function refusal(fetch: SafeFetch, url: string): Promise<ConnectorError> {
  const error = await fetch(url).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ConnectorError)) throw new Error(`expected a ConnectorError for ${url}`);
  return error;
}

describe('pinFetch', () => {
  it('refuses an off-origin URL before DNS, as a permanent CONFIG with reason OFF_ORIGIN', async () => {
    const h = harness();
    const pinned = pinFetch(h.safe, ['https://api.example.com']);
    const error = await refusal(pinned, 'https://evil.example.net/v1/members');
    expect(error.code).toBe('CONFIG');
    expect(error.permanent).toBe(true);
    expect(error.reason).toBe('OFF_ORIGIN');
    expect(h.dns).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it.each([
    'https://api.example.com.evil.net/x',
    'https://sub.api.example.com/x',
    'https://api.example.com:8443/x',
    'http://api.example.com/x',
    'https://api.example.com./x',
    'not a url',
    'data:text/plain,hi',
  ])('refuses %s against https://api.example.com', async (url) => {
    const h = harness();
    const error = await refusal(pinFetch(h.safe, ['https://api.example.com']), url);
    expect(error.reason).toBe('OFF_ORIGIN');
    expect(h.dns).toEqual([]);
  });

  it('lets a listed origin through to safe-fetch, matching case and the default port', async () => {
    const h = harness();
    const pinned = pinFetch(h.safe, ['https://API.Example.com:443/base/path']);
    expect((await pinned('https://api.example.com/v1/members?cursor=a')).status).toBe(200);
    expect((await pinned('https://api.EXAMPLE.com:443/v1/x')).status).toBe(200);
    expect(h.dns).toEqual(['api.example.com', 'api.example.com']);
    expect(h.sent).toHaveLength(2);
  });

  it('refuses everything for an empty list, and ignores unparseable or opaque entries', async () => {
    const h = harness();
    expect((await refusal(pinFetch(h.safe, []), 'https://api.example.com/')).reason).toBe(
      'OFF_ORIGIN',
    );
    const junk = pinFetch(h.safe, ['nope', 'data:text/plain,x', 'null']);
    expect((await refusal(junk, 'https://api.example.com/')).reason).toBe('OFF_ORIGIN');
    expect(h.dns).toEqual([]);
  });

  it('returns the same fetch when unpinned', () => {
    const h = harness();
    expect(pinFetch(h.safe, undefined)).toBe(h.safe);
  });

  it('builds a fresh error each time', () => {
    expect(offOrigin()).not.toBe(offOrigin());
  });
});

describe('egressFetch', () => {
  it('pins http-json to its base URL origin', async () => {
    const h = harness();
    const config = httpJson.configSchema.parse({ baseUrl: 'https://api.example.com/v1' });
    const fetch = egressFetch(httpJson, config, h.safe);
    expect((await fetch('https://api.example.com/v1/m-1')).status).toBe(200);
    expect((await refusal(fetch, 'https://other.example.com/v1/m-1')).reason).toBe('OFF_ORIGIN');
    expect(h.dns).toEqual(['api.example.com']);
  });

  it('leaves csv-url unchanged: the same fetch, and a cross-host redirect still followed', async () => {
    const published = 'https://docs.google.com/spreadsheets/d/e/x/pub?output=csv';
    const exported = 'https://doc-0s-sheets.googleusercontent.com/pub/x';
    const h = harness({ [published]: exported });
    const config = csvUrl.configSchema.parse({ url: published, idColumn: 'Id' });
    const fetch = egressFetch(csvUrl, config, h.safe);
    expect(fetch).toBe(h.safe);
    expect((await fetch(published)).status).toBe(200);
    expect(h.sent).toEqual([published, exported]);
  });

  it('gives a connector with no egress no network at all', async () => {
    const h = harness();
    for (const type of ['demo', 'webhook-push']) {
      const def = connectors.get(type) as AnyConnector;
      const fetch = egressFetch(def, def.configSchema.parse({}), h.safe);
      expect((await refusal(fetch, 'https://api.example.com/')).reason).toBe('OFF_ORIGIN');
    }
    expect(h.dns).toEqual([]);
  });
});

describe('connector egress declarations', () => {
  it('pins every connector but csv-url', () => {
    const unpinned = connectors
      .list()
      .filter((def) => def.egress === undefined)
      .map((def) => def.type);
    expect(unpinned).toEqual(['csv-url']);
  });

  it('follows no redirects in a pinned connector, so no hop can leave its origins', () => {
    const pinnedWithHops = connectors
      .list()
      .filter((def) => def.egress !== undefined && (def.defaults.maxRedirects ?? 0) > 0)
      .map((def) => def.type);
    expect(pinnedWithHops).toEqual([]);
  });
});
