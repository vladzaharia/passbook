import { describe, expect, it } from 'vitest';
import type { Component } from './groups.ts';
import { componentIcon } from './icons.ts';

describe('status icons', () => {
  it('gives every single-instance component its own glyph', () => {
    const rows: Pick<Component, 'id' | 'kind'>[] = [
      { id: 'database', kind: 'database' },
      { id: 'storage', kind: 'storage' },
      { id: 'queue', kind: 'queue' },
      { id: 'cron:sweep', kind: 'cron' },
      { id: 'build', kind: 'build' },
      { id: 'ratelimits', kind: 'build' },
      { id: 'email', kind: 'email' },
      { id: 'identity:platform', kind: 'identity' },
      { id: 'oidc', kind: 'oidc' },
      { id: 'breakglass', kind: 'oidc' },
      { id: 'turnstile', kind: 'oidc' },
      { id: 'connections', kind: 'connection' },
      { id: 'workflows', kind: 'workflow' },
    ];
    expect(new Set(rows.map(componentIcon)).size).toBe(rows.length);
  });
});
