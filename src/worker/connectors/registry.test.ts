import { describe, expect, it } from 'vitest';
import demo from './demo/index.ts';
import httpJson from './http-json/index.ts';
import { connectors, defineRegistry } from './registry.ts';
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
