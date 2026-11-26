import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  operationsKitCss,
  playgroundKitCss,
  searchKitCss,
  webhookSetupKitCss,
} from './lib/playground-kit.ts';

const root = resolve(import.meta.dirname, '..');

describe('generated playground kit CSS (tools/build-playground-kit.ts)', () => {
  it('is what the generator makes from the kit sources today (run `npm run gen`)', async () => {
    const generated = readFileSync(resolve(root, 'src/generated/playground-kit.css'), 'utf8');
    expect(generated).toBe(await playgroundKitCss(root));
  });

  it('has the classes the embedded kit pieces use, and no preflight that would reset the portal', () => {
    const css = readFileSync(resolve(root, 'src/generated/playground-kit.css'), 'utf8');
    for (const cls of ['.min-w-0', '.flex-col', '.gap-4', '.text-fg-muted', '.divide-border'])
      expect(css, cls).toContain(cls);
    expect(css).not.toMatch(/(^|\})(html|body|\*),?(:before|:after|::backdrop)?\{/);
    expect(css).not.toContain('tailwindcss v');
  });
});

describe('generated search kit CSS', () => {
  it('is what the generator makes from the palette sources today (run `npm run gen`)', async () => {
    const generated = readFileSync(resolve(root, 'src/generated/search-kit.css'), 'utf8');
    expect(generated).toBe(await searchKitCss(root));
  });

  it('carries the palette frame and stays out of the playground sheet', () => {
    const search = readFileSync(resolve(root, 'src/generated/search-kit.css'), 'utf8');
    const playground = readFileSync(resolve(root, 'src/generated/playground-kit.css'), 'utf8');
    expect(search).toContain('cmdk-group-heading');
    expect(search).toContain('.max-w-\\[880px\\]');
    expect(playground).not.toContain('cmdk-');
  });
});

describe('generated operations kit CSS (the developer site activity tray)', () => {
  it('is what the generator makes from the tray sources today (run `npm run gen`)', async () => {
    const generated = readFileSync(resolve(root, 'src/generated/operations-kit.css'), 'utf8');
    expect(generated).toBe(await operationsKitCss(root));
  });

  it('carries the tray, popover and sheet classes in px (the site root is 14 px), without preflight', () => {
    const css = readFileSync(resolve(root, 'src/generated/operations-kit.css'), 'utf8');
    for (const cls of ['.w-\\[22rem\\]', '.min-w-4', '.ring-2', '.font-mono'])
      expect(css, cls).toContain(cls);
    expect(css).not.toMatch(/(^|\})(html|body|\*),?(:before|:after|::backdrop)?\{/);
    expect(css).not.toContain('22rem}');
  });
});

describe('generated webhook-setup kit CSS (the developer site Workbench and docs)', () => {
  it('is what the generator makes from the kit sources today (run `npm run gen`)', async () => {
    const generated = readFileSync(resolve(root, 'src/generated/webhook-setup-kit.css'), 'utf8');
    expect(generated).toBe(await webhookSetupKitCss(root));
  });

  it('carries the kit parts and the button variants in px, without preflight', () => {
    const css = readFileSync(resolve(root, 'src/generated/webhook-setup-kit.css'), 'utf8');
    for (const cls of [
      '.grid-cols-\\[minmax\\(0\\,1fr\\)_22rem\\]',
      '.font-mono',
      '.min-h-11',
      '.rounded-md',
    ])
      expect(css, cls).toContain(cls);
    expect(css).not.toMatch(/(^|\})(html|body|\*),?(:before|:after|::backdrop)?\{/);
  });
});
