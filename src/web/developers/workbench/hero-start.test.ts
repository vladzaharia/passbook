import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ value: { kind: 'out' } as { kind: string } }));
vi.mock('../console/session.ts', () => ({ loadSession: async () => session.value }));

import { mount } from './hero-start.ts';

const fixture = () => {
  document.body.innerHTML =
    '<a class="btn" href="/developers/quickstart" data-hero-start data-island="hero-start">Start the quickstart<svg></svg></a>';
  return document.querySelector<HTMLAnchorElement>('a[data-hero-start]') as HTMLAnchorElement;
};
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
