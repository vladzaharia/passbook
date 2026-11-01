import { describe, expect, it } from 'vitest';
import staticHeaders from '../../../public/_headers?raw';
import {
  COOP,
  CORP,
  contentSecurityPolicy,
  HSTS,
  PERMISSIONS_POLICY,
  REFERRER_DEFAULT,
  XFO,
} from './security-headers.ts';

/** The /* block of public/_headers as name -> value. */
function staticBlock(): Map<string, string> {
  const block = staticHeaders.split(/\n\s*\n/)[0] ?? '';
  const out = new Map<string, string>();
  for (const line of block.split('\n').slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) out.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return out;
}

const TURNSTILE = ' https://challenges.cloudflare.com';

describe('security header parity', () => {
  const block = staticBlock();

  it('static CSP equals the Worker CSP apart from Turnstile and object-src', () => {
    const directives = (block.get('content-security-policy') ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => !d.startsWith('frame-src') && !d.startsWith('object-src'))
      .map((d) => d.replace(TURNSTILE, ''));
    const worker = contentSecurityPolicy()
      .split(';')
      .map((d) => d.trim());
    expect(directives.sort()).toEqual(worker.sort());
    expect(block.get('content-security-policy')).toContain("object-src 'none'");
  });

  it('every other header has one value in both sources', () => {
    expect(block.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    expect(block.get('strict-transport-security')).toBe(HSTS);
    expect(block.get('x-content-type-options')).toBe('nosniff');
    expect(block.get('referrer-policy')).toBe(REFERRER_DEFAULT);
    expect(block.get('cross-origin-opener-policy')).toBe(COOP);
    expect(block.get('cross-origin-resource-policy')).toBe(CORP);
    expect(block.get('x-frame-options')).toBe(XFO);
  });
});
