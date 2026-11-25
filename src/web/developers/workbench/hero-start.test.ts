import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: { kind: 'out' } as { kind: string } }));
vi.mock('../console/session.ts', () => ({ loadSession: async () => session.value }));

import { mount } from './hero-start.ts';

const fixture = () => {
  document.body.innerHTML = `<section class="hero">
    <a class="btn" href="/developers/quickstart" data-hero-start data-island="hero-start">Start the quickstart<svg></svg></a>
    <span data-buddy></span>
    <a class="btn" href="/auth/oidc/start" data-hero-try>Sign in to try</a>
  </section>`;
  return document.querySelector<HTMLAnchorElement>('a[data-hero-start]') as HTMLAnchorElement;
};
const tryLink = () => document.querySelector<HTMLAnchorElement>('[data-hero-try]');
afterEach(() => {
  document.body.innerHTML = '';
});

describe('hero start button', () => {
  it.each(['out', 'none', 'closed', 'failed'])('stays the quickstart for %s', async (kind) => {
    session.value = { kind };
    const a = fixture();
    await mount(a);
    expect(a.textContent).toBe('Start the quickstart');
    expect(a.getAttribute('href')).toBe('/developers/quickstart');
  });

  it('reads Run in console once the sandbox is open, keeping the arrow', async () => {
    session.value = { kind: 'ready' };
    const a = fixture();
    await mount(a);
    expect(a.textContent).toBe('Run in console');
    expect(a.getAttribute('href')).toBe('/developers/console');
    expect(a.querySelector('svg')).not.toBeNull();
  });
});

describe('hero ticket and buddy', () => {
  it.each(['out', 'failed'])(
    'keep the sign-in and the hero buddy for %s, and show them',
    async (kind) => {
      session.value = { kind };
      await mount(fixture());
      expect(tryLink()?.textContent).toBe('Sign in to try');
      expect(document.querySelector('[data-buddy]')?.hasAttribute('data-ready')).toBe(true);
      expect(tryLink()?.hasAttribute('data-ready')).toBe(true);
    },
  );

  it.each([
    ['ready', 'Run in console', '/developers/console'],
    ['none', 'Create sandbox', '/developers/quickstart#sandbox'],
    ['closed', 'Sandbox closed', '/developers/quickstart#sandbox'],
  ])('signed in (%s): no Sign in, no hero buddy', async (kind, text, href) => {
    session.value = { kind };
    await mount(fixture());
    expect(tryLink()?.textContent).toBe(text);
    expect(tryLink()?.getAttribute('href')).toBe(href);
    expect(tryLink()?.hasAttribute('data-ready')).toBe(true);
    expect(document.querySelector('[data-buddy]')).toBeNull();
    expect(document.body.textContent).not.toContain('Sign in');
  });
});
