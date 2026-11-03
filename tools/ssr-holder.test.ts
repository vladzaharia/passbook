import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceInfo } from '../src/shared/device.ts';
import { assets, fixtures } from '../src/shared/pass-view/fixtures/index.ts';
import { normalize } from '../src/shared/pass-view/index.ts';
import { candidatesOf, ssrHolderCss } from './lib/ssr-holder.ts';

const root = resolve(import.meta.dirname, '..');
// A JSX module: the Node typecheck has no JSX, so it is loaded untyped.
const PAGE_MODULE = '../src/worker/ssr/pass-page.tsx';
const { renderPassPage } = (await import(PAGE_MODULE)) as {
  renderPassPage: (props: Record<string, unknown>) => string;
};
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const generated = read('src/generated/ssr-holder.css');

/** The sheets /p inlines for its body (pass-page.tsx PAGE_CSS); Vitest gives ?raw imports empty. */
const SHEETS = [
  'src/generated/ssr-holder.css',
  'src/web/pass-card/pass-card-base.css',
  'src/web/pass-card/pass-card-poster.css',
  'src/web/pass-card/pass-card-text.css',
  'src/web/pass-card/stage.css',
  'src/web/pass-card/stage-motion.css',
  'src/web/pass-card/stage-seg.css',
  'src/web/portal/holder-pass.css',
]
  .map(read)
  .join('\n');

const view = (over: Record<string, unknown> = {}) =>
  normalize(
    { ...fixtures.generic, ...over },
    { assets, now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' },
  );
const page = (over: Record<string, unknown> = {}) =>
  renderPassPage({
    view: view(),
    nonce: 'n0nce',
    orgName: 'Gym',
    orgLabel: 'Gym',
    passTitle: 'Membership',
    downloadHref: '/p/t/pass.pkpass',
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    device: { device: 'other', inApp: false },
    support: { email: 'help@gym.test', url: 'https://gym.test/help' },
    ...over,
  });
const DEVICES: DeviceInfo[] = [
  { device: 'iphone', inApp: false },
  { device: 'iphone', inApp: true },
  { device: 'mac', inApp: false },
  { device: 'other', inApp: false },
];
const PAGES = [
  ...DEVICES.map((device) => page({ device })),
  page({ voided: true }),
  page({ view: view({ expirationDate: '2020-01-01T00:00:00Z' }) }),
];

/** Tailwind's selector for a class name: every character outside [\w-] escaped. */
const selector = (cls: string) => `.${cls.replace(/[^\w-]/g, (c) => `\\${c}`)}`;
/** Hooks: portal.css's nudge look, pass-page.tsx's own dip rule; markers no sheet styles. */
const HOOKS = new Set(['wl-pass-side', 'wl-holder']);

describe('generated /p CSS (tools/build-ssr-holder.ts)', () => {
  it('is current: `npm run gen` writes exactly the committed file', async () => {
    expect(generated).toBe(await ssrHolderCss(root));
  });

  it('reads the class names of the shared view and the kit pieces in it', () => {
    const words = candidatesOf(root);
    for (const cls of [
      'lg:grid-cols-[22rem_minmax(0,1fr)]',
      'pointer-fine:h-10',
      'bg-warning-subtle',
    ])
      expect(words).toContain(cls);
  });

  it('carries Tailwind preflight, then the utilities, unlayered', () => {
    expect(generated).toContain('*,:after,:before,::backdrop{box-sizing:border-box');
    expect(generated).not.toMatch(/@layer (base|utilities)/);
  });

  it('has a rule for every class /p names, on every device and state', () => {
    for (const html of PAGES) {
      const body = html.slice(html.indexOf('<body>'));
      const classes = new Set(
        [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(' ')),
      );
      for (const cls of classes) {
        if (!cls || cls.startsWith('lucide') || HOOKS.has(cls)) continue;
        expect([cls, SHEETS.includes(selector(cls))]).toEqual([cls, true]);
      }
    }
  });
});
