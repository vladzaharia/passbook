import { beforeEach, describe, expect, it } from 'vitest';
import { bridgeFromSearch, bridgeHref, bridgeLabel, readBridgeOrigin } from './workbench-bridge.ts';

describe('bridge launch links', () => {
  it('names this org, the tool and the page it left, and never a body', () => {
    const href = bridgeHref(
      'org 1',
      'events',
      '/admin/o/org%201/connections/webhooks/w1?tab=deliveries',
      {
        query: { tab: 'endpoints' },
        hash: 'w1',
      },
    );
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/workbench/o/org%201/events');
    expect(url.searchParams.get('from')).toBe('admin');
    expect(url.searchParams.get('return')).toBe(
      '/admin/o/org%201/connections/webhooks/w1?tab=deliveries',
    );
    expect(url.hash).toBe('#w1');
    expect(() => bridgeHref('o', 'passes', '/admin/', { query: { body: '{}' } })).toThrow();
  });
});

describe('arriving from the Workbench', () => {
  beforeEach(() => sessionStorage.clear());

  it('takes a Workbench return and refuses anything else', () => {
    expect(bridgeFromSearch('?from=workbench&return=/workbench/o/a/events%23e1')).toBe(
      '/workbench/o/a/events#e1',
    );
    expect(bridgeFromSearch('?from=workbench&return=https://evil.example/workbench/')).toBeNull();
    expect(bridgeFromSearch('?from=workbench&return=//evil.example')).toBeNull();
    expect(bridgeFromSearch('?from=workbench&return=/admin/o/a')).toBeNull();
    expect(bridgeFromSearch('?from=docs&return=/workbench/o/a')).toBeNull();
    expect(bridgeFromSearch('')).toBeNull();
  });

  it('reads a stored way back only if it still points into the Workbench', () => {
    sessionStorage.setItem(
      'adm-origin',
      JSON.stringify({ return: '/workbench/o/a/logs', hops: 1 }),
    );
    expect(readBridgeOrigin()).toEqual({ return: '/workbench/o/a/logs', hops: 1 });
    sessionStorage.setItem('adm-origin', JSON.stringify({ return: '/admin/o/a', hops: 0 }));
    expect(readBridgeOrigin()).toBeNull();
    sessionStorage.setItem('adm-origin', '{not json');
    expect(readBridgeOrigin()).toBeNull();
  });

  it('names the tool it left', () => {
    expect(bridgeLabel('/workbench/o/a/events')).toBe('Events');
    expect(bridgeLabel('/workbench/o/a')).toBe('Home');
    expect(bridgeLabel('/workbench')).toBe('Workbench');
  });
});
