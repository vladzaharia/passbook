import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../../index.html?raw';
import themeInit from '../../../public/theme-init.js?raw';
import { applyPref, applyThemeColor, readPref, THEME_COLOR, THEME_KEY } from './theme.tsx';

type Stored = string | null | 'throw';

function setUp(cookie: string | null, stored: Stored, path: string) {
  window.history.replaceState(null, '', path);
  // biome-ignore lint/suspicious/noDocumentCookie: the theme cookie under test
  document.cookie = cookie === null ? `${THEME_KEY}=; Max-Age=0` : `${THEME_KEY}=${cookie}`;
  vi.stubGlobal('localStorage', {
    getItem: () => {
      if (stored === 'throw') throw new Error('blocked');
      return stored;
    },
  });
}

const root = document.documentElement;
const reset = () => {
  delete root.dataset.theme;
  delete root.dataset.themePref;
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  // biome-ignore lint/suspicious/noDocumentCookie: clears the cookie under test
  document.cookie = `${THEME_KEY}=; Max-Age=0`;
  reset();
});

const COOKIES = [null, 'dark', 'light', 'system', 'neon'];
const STORED: Stored[] = [null, 'dark', 'light', 'system', 'neon', 'throw'];
const PATHS = ['/', '/admin/passes', '/login', '/account', '/administrator'];
const cases = COOKIES.flatMap((c) => STORED.flatMap((s) => PATHS.map((p) => [c, s, p] as const)));

describe('theme-init.js', () => {
  it.each(cases)('cookie %s, storage %s on %s: matches readPref + applyPref', (c, s, p) => {
    setUp(c, s, p);
    root.dataset.theme = 'stale';
    new Function(themeInit)();
    const script = { theme: root.dataset.theme, pref: root.dataset.themePref };
    reset();
    root.dataset.theme = 'stale';
    applyPref(readPref());
    expect(script).toEqual({ theme: root.dataset.theme, pref: root.dataset.themePref });
  });

  it('reads the cookie before storage, on every path', () => {
    setUp('light', 'dark', '/login');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('light');
    reset();
    setUp(null, 'dark', '/');
    new Function(themeInit)();
    expect(root.dataset.theme).toBe('dark');
  });

  it('does not throw when storage is blocked', () => {
    setUp(null, 'throw', '/admin');
    expect(() => new Function(themeInit)()).not.toThrow();
    expect(root.dataset.themePref).toBe('system');
  });
});

describe('theme-color', () => {
  it('index.html colours the first paint with the same pair, by media', () => {
    expect(indexHtml).toContain(
      `<meta name="theme-color" content="${THEME_COLOR.light}" media="(prefers-color-scheme: light)" />`,
    );
    expect(indexHtml).toContain(
      `<meta name="theme-color" content="${THEME_COLOR.dark}" media="(prefers-color-scheme: dark)" />`,
    );
  });

  it('collapses the pair into one meta for the theme on screen', () => {
    const head = document.createElement('div');
    head.innerHTML = `<meta name="theme-color" content="#000" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#111" media="(prefers-color-scheme: dark)">`;
    applyThemeColor('dark', head);
    const metas = head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toBe(THEME_COLOR.dark);
    expect(metas[0]?.hasAttribute('media')).toBe(false);
  });

  it('adds the meta when the page has none', () => {
    const head = document.createElement('div');
    applyThemeColor('light', head);
    expect(head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      THEME_COLOR.light,
    );
  });
});
