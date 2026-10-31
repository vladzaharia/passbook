import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../../index.html?raw';
import headersFile from '../../../public/_headers?raw';
import themeInit from '../../../public/theme-init.js?raw';

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
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(csp, 'style-src')).toBe("style-src 'self'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('challenges.cloudflare.com');
  });

  it('allows Turnstile only on /login, replacing the global CSP', () => {
    const login = rule('/login');
    expect(login?.unset).toContain('Content-Security-Policy');
    const loginCsp = login?.set['Content-Security-Policy'] ?? '';
    expect(directive(loginCsp, 'script-src')).toBe(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(directive(loginCsp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(loginCsp).not.toContain('unsafe-inline');
    expect(directive(loginCsp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
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
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePref;
  });

  const run = (stored: string | null | 'throw') => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        if (stored === 'throw') throw new Error('blocked');
        return stored;
      },
    });
    new Function(themeInit)();
  };

  it.each(['dark', 'light'])('applies a stored %s theme', (value) => {
    run(value);
    expect(document.documentElement.dataset.theme).toBe(value);
    expect(document.documentElement.dataset.themePref).toBe(value);
  });

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
