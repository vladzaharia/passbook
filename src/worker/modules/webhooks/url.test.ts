import { describe, expect, it } from 'vitest';
import { hostOf, maskUrl, normalizeEndpointUrl } from './url.ts';

describe('endpoint url', () => {
  it('keeps a public https url and drops the fragment', () => {
    expect(normalizeEndpointUrl('https://Hooks.Example.com/a/b?x=1#frag', [])).toBe(
      'https://hooks.example.com/a/b?x=1',
    );
  });

  it.each([
    'http://hooks.example.com/a',
    'https://hooks.example.com:8443/a',
    'https://user:pw@hooks.example.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://intranet/a',
    'https://printer.local/a',
    'https://hooks.example.com/a/../b',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => normalizeEndpointUrl(url, [])).toThrow();
  });

  it('refuses a platform host and its subdomains', () => {
    expect(() =>
      normalizeEndpointUrl('https://wallet.example.org/x', ['wallet.example.org']),
    ).toThrow();
    expect(() =>
      normalizeEndpointUrl('https://a.wallet.example.org/x', ['wallet.example.org']),
    ).toThrow();
  });

  it('shows only the host in logs and audit, and the host plus four path characters to readers', () => {
    const url = 'https://hooks.zapier.com/hooks/catch/123/secretabcd?token=s3cret';
    expect(hostOf(url)).toBe('hooks.zapier.com');
    expect(maskUrl(url)).toBe('hooks.zapier.com/…abcd');
    expect(maskUrl(url)).not.toContain('s3cret');
    expect(maskUrl('https://hooks.example.com/')).toBe('hooks.example.com');
  });
});
