import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { renderBundlePage } from './bundle-page.tsx';
import { renderPassPage } from './pass-page.tsx';
import { TestRibbon } from './test-ribbon.tsx';

const view = normalize(fixtures.generic, {
  assets,
  now: new Date('2026-10-31T12:00:00Z'),
  timeZone: 'UTC',
});

const pass = (mode?: 'live' | 'test') =>
  renderPassPage({
    view,
    nonce: 'n',
    orgName: 'Gym',
    orgLabel: 'Gym',
    passTitle: 'Membership',
    downloadHref: '/p/t/pass.pkpass',
    publicUrl: 'https://wallet.test/p/t',
    portalHref: '/passes/p1',
    voided: false,
    ...(mode ? { mode } : {}),
    device: { device: 'other', inApp: false },
  });

const bundle = (mode?: 'live' | 'test') =>
  renderBundlePage({
    nonce: 'n',
    orgName: 'Gym',
    orgLabel: 'Gym',
    name: 'Family',
    items: [{ id: 'a', view, title: 'A', voided: false, downloadHref: '/b/t/a/pass.pkpass' }],
    ...(mode ? { mode } : {}),
    addAllHref: '/b/t/passes.pkpasses',
    publicUrl: 'https://wallet.test/b/t',
    device: { device: 'other', inApp: false },
  });

describe('test ribbon on /p and /b', () => {
  it('shows on a test pass and a test bundle, never on live ones', () => {
    expect(pass('test')).toContain('wl-test-strip');
    expect(pass('test')).toContain('Test pass.');
    expect(bundle('test')).toContain('Test bundle.');
    for (const html of [pass('live'), pass(), bundle('live'), bundle()])
      expect(html).not.toContain('wl-test-strip');
  });

  it('renders nothing for live', () => {
    expect(renderToStaticMarkup(createElement(TestRibbon, { mode: 'live', what: 'pass' }))).toBe(
      '',
    );
  });
});
