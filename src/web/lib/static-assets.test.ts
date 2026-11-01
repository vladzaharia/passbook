import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../../index.html?raw';
import headersFile from '../../../public/_headers?raw';
import themeInit from '../../../public/theme-init.js?raw';
import viteConfig from '../../../vite.config.ts?raw';
import mainSource from '../main.tsx?raw';

interface Rule {
  path: string;
  set: Record<string, string>;
  unset: string[];
}

function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), set: {}, unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    const body = line.trim();
    if (body.startsWith('!')) rule?.unset.push(body.slice(1).trim());
    else {
      const i = body.indexOf(':');
      if (rule) rule.set[body.slice(0, i).trim()] = body.slice(i + 1).trim();
    }
  }
  return rules;
}

const rules = parseHeaders(headersFile);
const rule = (path: string) => rules.find((r) => r.path === path);
const directive = (csp: string, name: string) =>
  csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

describe('public/_headers', () => {
  const csp = rule('/*')?.set['Content-Security-Policy'] ?? '';

  it('sets a strict CSP for everything', () => {
    expect(directive(csp, 'default-src')).toBe("default-src 'none'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows Turnstile on every SPA document (client-side navigation keeps the first CSP)', () => {
    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' https://challenges.cloudflare.com",
    );
    expect(rule('/login')).toBeUndefined();
  });

  it('lets mail clients load the wallet badge cross-origin', () => {
    const apple = rule('/apple/*');
    expect(apple?.unset).toContain('Cross-Origin-Resource-Policy');
    expect(apple?.set['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  it('sets the baseline security headers', () => {
    const set = rule('/*')?.set ?? {};
    expect(set['Strict-Transport-Security']).toMatch(/max-age=31536000; includeSubDomains/);
    expect(set['X-Content-Type-Options']).toBe('nosniff');
    expect(set['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(set['Permissions-Policy']).toContain('camera=()');
    expect(set['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('caches hashed assets for a year and does not cache the HTML shell', () => {
    expect(rule('/assets/*')?.set['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(rule('/*')?.set['Cache-Control']).toBeUndefined();
  });
});

const baseCss = readFileSync('src/web/styles/base.css', 'utf8');

describe('CSP-safe bundle', () => {
  it('runs zod without eval', () => {
    expect(mainSource).toContain('z.config({ jitless: true })');
  });
  it('replaces Radix inline styles with base.css rules', () => {
    expect(viteConfig).toContain('radixNoInlineStyles()');
    expect(baseCss).toContain('body[data-scroll-locked]');
    expect(baseCss).toContain('[data-radix-select-viewport]');
  });
});

describe('index.html', () => {
  it('has no inline scripts or styles and loads the theme script before the app', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(indexHtml).not.toMatch(/<style[\s>]/);
    expect(indexHtml).not.toMatch(/\sstyle=/);
    expect(indexHtml.indexOf('/theme-init.js')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('/theme-init.js')).toBeLessThan(
      indexHtml.indexOf('/src/web/main.tsx'),
    );
  });
});

describe('theme-init.js', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePref;
  });

  const run = (stored: string | null | 'throw', path = '/admin/passes') => {
    window.history.replaceState(null, '', path);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        if (stored === 'throw') throw new Error('blocked');
        return stored;
      },
    });
    new Function(themeInit)();
  };

  it.each(['dark', 'light'])('applies a stored %s theme in the admin console', (value) => {
    run(value);
    expect(document.documentElement.dataset.theme).toBe(value);
    expect(document.documentElement.dataset.themePref).toBe(value);
  });

  it.each(['/', '/account', '/login', '/administrator'])(
    'ignores the stored theme on holder page %s',
    (path) => {
      run('dark', path);
      expect(document.documentElement.dataset.theme).toBeUndefined();
      expect(document.documentElement.dataset.themePref).toBe('system');
    },
  );

  it.each([null, 'system', 'neon'])('leaves the system theme for %s', (value) => {
    document.documentElement.dataset.theme = 'dark';
    run(value);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.dataset.themePref).toBe('system');
  });

  it('does not throw when storage is blocked', () => {
    expect(() => run('throw')).not.toThrow();
  });
});
