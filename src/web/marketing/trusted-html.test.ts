import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKETING_POLICY } from '@/shared/marketing.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('trustedHtml', () => {
  it('returns the string where Trusted Types is missing', async () => {
    vi.stubGlobal('trustedTypes', undefined);
    const { trustedHtml } = await import('./trusted-html.ts');
    expect(trustedHtml('<svg></svg>')).toBe('<svg></svg>');
  });

  it('wraps through one passbook-marketing policy', async () => {
    const createPolicy = vi.fn((_name: string, rules: { createHTML(s: string): string }) => rules);
    vi.stubGlobal('trustedTypes', { createPolicy });
    const { trustedHtml } = await import('./trusted-html.ts');
    expect(trustedHtml('<g></g>')).toBe('<g></g>');
    expect(trustedHtml('<g></g>')).toBe('<g></g>');
    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(createPolicy.mock.calls[0]?.[0]).toBe(MARKETING_POLICY);
    expect(MARKETING_POLICY).toBe('passbook-marketing');
  });
});
