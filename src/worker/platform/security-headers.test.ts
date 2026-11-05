import { describe, expect, it } from 'vitest';
import staticHeaders from '../../../public/_headers?raw';
import {
  COOP,
  CORP,
  contentSecurityPolicy,
  DECODE_WORKER_CSP,
  HSTS,
  PERMISSIONS_POLICY,
  REFERRER_DEFAULT,
  SCAN_PERMISSIONS_POLICY,
  scanContentSecurityPolicy,
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
      .filter((d) => !d.startsWith('object-src'))
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

interface Block {
  pattern: string;
  /** In file order: `! Name` removes, `Name: value` adds. */
  lines: { remove: boolean; name: string; value: string }[];
}

function blocks(): Block[] {
  return staticHeaders
    .split(/\n\s*\n/)
    .map((raw) => raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')))
    .filter((lines) => lines[0]?.startsWith('/'))
    .map(([pattern = '', ...rest]) => ({
      pattern: pattern.trim(),
      lines: rest.map((line) => {
        const remove = line.trim().startsWith('!');
        const text = line.trim().replace(/^!\s*/, '');
        const at = text.indexOf(':');
        return remove
          ? { remove, name: text.toLowerCase(), value: '' }
          : {
              remove,
              name: text.slice(0, at).trim().toLowerCase(),
              value: text.slice(at + 1).trim(),
            };
      }),
    }));
}

const matches = (pattern: string, path: string) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

/** What Cloudflare answers for a path: every matching block merged, in order. */
function headersFor(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of blocks()) {
    if (!matches(block.pattern, path)) continue;
    for (const line of block.lines) {
      if (line.remove) out.delete(line.name);
      else out.set(line.name, [...(out.get(line.name) ?? []), line.value]);
    }
  }
  return out;
}

describe('the scanner document and its decoder worker', () => {
  const scan = headersFor('/scan');
  const worker = headersFor('/assets/decode-worker-AbC123.js');

  it('/scan carries exactly one CSP and one Permissions-Policy, with the camera and wasm', () => {
    expect(scan.get('content-security-policy')).toHaveLength(1);
    expect(scan.get('permissions-policy')).toEqual([SCAN_PERMISSIONS_POLICY]);
    expect(scan.get('referrer-policy')).toEqual(['no-referrer']);
    const csp = scan.get('content-security-policy')?.[0] ?? '';
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("connect-src 'self' ");
  });

  it('/scan keeps customer screens and monitors awake, and the SPA policy is unchanged', () => {
    expect(SCAN_PERMISSIONS_POLICY).toContain('screen-wake-lock=(self)');
    expect(scan.get('permissions-policy')?.[0]).toContain('screen-wake-lock=(self)');
    expect(PERMISSIONS_POLICY).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  });

  it('/scan CSP equals the Worker scan CSP apart from Turnstile and object-src', () => {
    const directives = (scan.get('content-security-policy')?.[0] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => !d.startsWith('object-src'))
      .map((d) => d.replace(TURNSTILE, ''));
    const code = scanContentSecurityPolicy()
      .split(';')
      .map((d) => d.trim());
    expect(directives.sort()).toEqual(code.sort());
  });

  it('the decoder worker file has exactly one CSP, its own', () => {
    expect(worker.get('content-security-policy')).toEqual([DECODE_WORKER_CSP]);
    expect(worker.get('cache-control')).toEqual(['public, max-age=31536000, immutable']);
  });

  it('every SPA path keeps camera=() and one CSP', () => {
    for (const path of ['/', '/admin', '/login', '/scanner', '/assets/index-abc.js']) {
      const headers = headersFor(path);
      expect(headers.get('permissions-policy'), path).toEqual([PERMISSIONS_POLICY]);
      expect(headers.get('content-security-policy'), path).toHaveLength(1);
    }
    expect(PERMISSIONS_POLICY).toContain('camera=()');
  });

  it('serves the manifest as application/manifest+json', () => {
    expect(headersFor('/scan.webmanifest').get('content-type')).toEqual([
      'application/manifest+json',
    ]);
  });
});
