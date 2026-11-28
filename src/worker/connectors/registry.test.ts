import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import csvUrl from './csv-url/index.ts';
import demo from './demo/index.ts';
import fileUpload from './file-upload/index.ts';
import httpJson from './http-json/index.ts';
import { connectors, defineRegistry } from './registry.ts';
import { type AnyConnector, declareCapabilities } from './types.ts';
import webhookPush from './webhook-push/index.ts';

describe('connector registry webhook reference metadata', () => {
  it('exposes metadata on the discovered built-ins without enabling unsupported webhooks', () => {
    expect(connectors.get('webhook-push')).toBe(webhookPush);
    expect(connectors.get('http-json')).toBe(httpJson);
    expect(connectors.get('demo')).toBe(demo);
    expect(webhookPush.webhookReferenceMode).toBe('embedded-required');
    expect(httpJson.webhookReferenceMode).toBe('refs-only');
    expect(demo.webhookReferenceMode).toBe('refs-only');
    expect(webhookPush.verifyWebhook).toBeTypeOf('function');
    expect(httpJson.verifyWebhook).toBeTypeOf('function');
    expect(demo.verifyWebhook).toBeUndefined();
  });

  it('preserves explicitly declared metadata independently of connector type', () => {
    const embedded = {
      ...demo,
      type: 'custom-embedded',
      webhookReferenceMode: 'embedded-required',
    } as const;
    const refs = {
      ...webhookPush,
      type: 'custom-refs',
      webhookReferenceMode: 'refs-only',
    } as const;
    const registry = defineRegistry([embedded, refs]);
    expect(registry.get('custom-embedded')?.webhookReferenceMode).toBe('embedded-required');
    expect(registry.get('custom-refs')?.webhookReferenceMode).toBe('refs-only');
    expect(registry.list()).toEqual([embedded, refs]);
  });
});

describe('built-in capability declarations', () => {
  it('declares read-only v2 capabilities and keeps the flags the core reads', () => {
    const declared = [csvUrl, demo, fileUpload, httpJson, webhookPush].map((d) => [
      d.type,
      d.capabilities,
    ]);
    expect(declared).toEqual([
      ['csv-url', { read: { list: true }, auth: 'none', poll: true }],
      ['demo', { read: { list: true, delta: true }, auth: 'none', poll: true, delta: true }],
      ['file-upload', { read: { upload: true }, auth: 'none', upload: true }],
      [
        'http-json',
        {
          read: { fetch: true, list: true, delta: true },
          inbound: { webhook: 'manual' },
          auth: 'secret',
          poll: true,
          delta: true,
          webhook: true,
        },
      ],
      ['webhook-push', { inbound: { webhook: 'manual' }, auth: 'secret', webhook: true }],
    ]);
    for (const d of connectors.list()) {
      expect(d.capabilities.write).toBeUndefined();
      expect(d.capabilities.outbound).toBeUndefined();
    }
  });
});

const noop = async () => {
  throw new Error('not called');
};
const listed: AnyConnector = { ...demo, type: 'probe' };
const pushed: AnyConnector = { ...webhookPush, type: 'probe' };
const writer: AnyConnector = {
  ...demo,
  type: 'probe',
  capabilities: declareCapabilities({
    read: { list: true },
    write: { objects: { member: ['update'] } },
    auth: 'none',
  }),
  objects: {
    member: { label: 'Member', fields: { points: { type: 'number', direction: 'out' } } },
  },
  mapEvent: () => [],
  write: noop,
};

describe('defineRegistry refuses a declaration that does not match the methods', () => {
  it('accepts consistent declarations, including write, outbound, managed hooks and OAuth', () => {
    const managed: AnyConnector = {
      ...pushed,
      type: 'managed',
      capabilities: declareCapabilities({ inbound: { webhook: 'managed' }, auth: 'oauth2' }),
      oauth: { authorizeUrl: () => '', tokenUrl: () => '', scopes: () => [] },
      registerWebhooks: noop,
      unregisterWebhooks: noop,
    };
    const outbound: AnyConnector = {
      ...writer,
      type: 'outbound',
      capabilities: declareCapabilities({
        write: { objects: { member: ['update'] } },
        outbound: { events: ['pass.scanned'] },
        auth: 'none',
      }),
      listChanges: undefined,
    };
    expect(defineRegistry([writer, managed, outbound]).list()).toHaveLength(3);
  });

  const cases: [string, AnyConnector, RegExp][] = [
    [
      'a listing without read.list or read.upload',
      { ...listed, capabilities: declareCapabilities({ auth: 'none' }) },
      /listChanges/,
    ],
    [
      'read.list without listChanges',
      { ...listed, listChanges: undefined },
      /read\.list needs listChanges/,
    ],
    [
      'read.delta without read.list',
      { ...listed, capabilities: declareCapabilities({ read: { delta: true }, auth: 'none' }) },
      /read\.delta needs read\.list/,
    ],
    [
      'read.import without importRecords',
      {
        ...listed,
        capabilities: declareCapabilities({ read: { list: true, import: true }, auth: 'none' }),
      },
      /read\.import/,
    ],
    ['importRecords without read.import', { ...listed, importRecords: noop }, /read\.import/],
    [
      'an inbound webhook without verifyWebhook',
      { ...pushed, verifyWebhook: undefined },
      /inbound\.webhook/,
    ],
    [
      'verifyWebhook without an inbound webhook',
      { ...listed, verifyWebhook: noop },
      /inbound\.webhook/,
    ],
    [
      'a managed webhook without register and unregister',
      {
        ...pushed,
        capabilities: declareCapabilities({ inbound: { webhook: 'managed' }, auth: 'secret' }),
      },
      /managed/,
    ],
    [
      'hook methods on a manual webhook',
      { ...pushed, registerWebhooks: noop, unregisterWebhooks: noop },
      /managed/,
    ],
    ['write.objects without write', { ...writer, write: undefined }, /mapEvent and write/],
    [
      'write methods with nothing declared to write',
      { ...listed, mapEvent: () => [], write: noop },
      /mapEvent and write/,
    ],
    [
      'outbound.events without write methods',
      {
        ...listed,
        capabilities: declareCapabilities({
          read: { list: true },
          outbound: { events: ['pass.voided'] },
          auth: 'none',
        }),
      },
      /mapEvent and write/,
    ],
    ['a written object missing from the catalog', { ...writer, objects: {} }, /member/],
    [
      'an empty op list',
      {
        ...writer,
        capabilities: declareCapabilities({
          read: { list: true },
          write: { objects: { member: [] } },
          auth: 'none',
        }),
      },
      /member/,
    ],
    [
      'an outgoing field on an object that is not written',
      {
        ...listed,
        objects: {
          guest: { label: 'Guest', fields: { tag: { type: 'string', direction: 'both' } } },
        },
      },
      /guest/,
    ],
    [
      'auth oauth2 without OAuth endpoints',
      {
        ...pushed,
        capabilities: declareCapabilities({ inbound: { webhook: 'manual' }, auth: 'oauth2' }),
      },
      /oauth/,
    ],
    [
      'OAuth endpoints without auth oauth2',
      { ...pushed, oauth: { authorizeUrl: () => '', tokenUrl: () => '', scopes: () => [] } },
      /oauth/,
    ],
    [
      'auth none with a secret schema',
      { ...listed, secretSchema: z.object({ token: z.string() }) },
      /auth none/,
    ],
    [
      'auth secret with no secret and no webhook',
      { ...listed, capabilities: declareCapabilities({ read: { list: true }, auth: 'secret' }) },
      /auth secret/,
    ],
    [
      'flags set by hand',
      { ...listed, capabilities: { ...listed.capabilities, upload: true } },
      /flags/,
    ],
  ];

  it.each(cases)('refuses %s', (_name, definition, message) => {
    expect(() => defineRegistry([definition])).toThrow(message);
  });

  it('names the connector it refuses', () => {
    expect(() => defineRegistry([{ ...listed, listChanges: undefined }])).toThrow(
      /^Connector probe/,
    );
  });
});
