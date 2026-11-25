import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import staticHeaders from '../../../public/_headers?raw';
import { MARKETING_POLICY } from '../../shared/marketing.ts';
import type { AppBindings } from './context.ts';
import {
  COOP,
  CORP,
  contentSecurityPolicy,
  DECODE_WORKER_CSP,
  HSTS,
  marketingContentSecurityPolicy,
  PERMISSIONS_POLICY,
  REFERRER_DEFAULT,
  REFERRER_ORIGIN_ONLY,
  SCAN_PERMISSIONS_POLICY,
  scanContentSecurityPolicy,
  securityHeaders,
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
/** The static SPA always may load Turnstile, so it names the policy the Worker's default leaves at none. */
const STATIC_TT = 'trusted-types passbook-turnstile passbook-save';
const WORKER_TT = "trusted-types 'none'";

describe('security header parity', () => {
  const block = staticBlock();

  it('static CSP equals the Worker CSP apart from Turnstile and object-src', () => {
    const directives = (block.get('content-security-policy') ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((d) => !d.startsWith('object-src'))
      .map((d) => d.replace(TURNSTILE, '').replace(STATIC_TT, WORKER_TT));
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
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types passbook-turnstile passbook-worker;');
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
      .map((d) =>
        d
          .replace(TURNSTILE, '')
          .replace(
            'trusted-types passbook-turnstile passbook-worker',
            'trusted-types passbook-worker',
          ),
      );
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

describe('trusted types on the pass pages', () => {
  it('lets the pass pages make the save policy and no other page', async () => {
    const app = new Hono<AppBindings>();
    app.use('*', securityHeaders);
    app.get('*', (c) => c.text('ok'));
    for (const path of ['/p/abc/barcode', '/b/abc/barcode']) {
      const csp = (await app.request(path)).headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain(
        "require-trusted-types-for 'script'; trusted-types passbook-save;",
      );
    }
    const other = (await app.request('/auth/magic')).headers.get('content-security-policy') ?? '';
    expect(other).toContain("trusted-types 'none'");
  });
});

describe('join page CSP', () => {
  const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
  const probe = async (path: string) => {
    const app = new Hono<AppBindings>();
    app.use('*', securityHeaders);
    app.get('*', (c) => c.text('ok'));
    return app.request(path);
  };

  it('adds Turnstile to script-src and frame-src for /j/ only, with an origin-only referrer', async () => {
    const join = await probe('/j/abc');
    const csp = join.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`script-src 'self' ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain(`frame-src 'self' ${TURNSTILE_ORIGIN}`);
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types passbook-turnstile;');
    expect(join.headers.get('referrer-policy')).toBe(REFERRER_ORIGIN_ONLY);
    for (const path of ['/auth/magic', '/api/v1/join-links/t', '/jx', '/joined/x', '/']) {
      const other = await probe(path);
      const otherCsp = other.headers.get('content-security-policy') ?? '';
      expect(otherCsp, path).not.toContain(TURNSTILE_ORIGIN);
      expect(otherCsp, path).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    }
  });

  it('leaves every other directive as the default policy', () => {
    const strip = (v: string) =>
      v
        .replaceAll(` ${TURNSTILE_ORIGIN}`, '')
        .replace('trusted-types passbook-turnstile', WORKER_TT);
    expect(strip(contentSecurityPolicy('n', { turnstile: true }))).toBe(contentSecurityPolicy('n'));
    expect(contentSecurityPolicy()).not.toContain(TURNSTILE_ORIGIN);
  });
});

describe('marketing CSP', () => {
  const csp = marketingContentSecurityPolicy();
  const directive = (name: string) =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `));

  it('allows no inline script, no foreign origin and one Trusted Types policy', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('style-src')).toBe("style-src 'self'");
    expect(directive('style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
    expect(directive('require-trusted-types-for')).toBe("require-trusted-types-for 'script'");
    expect(directive('trusted-types')).toBe(`trusted-types ${MARKETING_POLICY}`);
    expect(csp).not.toMatch(/https?:|nonce-|unsafe-eval|wasm/);
  });
});
