import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../console/session.ts';

const loadSession = vi.fn<() => Promise<Session>>();
vi.mock('../console/session.ts', () => ({
  loadSession: () => loadSession(),
  signedOutGate: () => ({ reason: 'none' }),
}));
vi.mock('./quickstart.tsx', () => ({ Quickstart: () => <p>Steps</p> }));
vi.mock('../playground/jitless.ts', () => ({ disableZodCompiling: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = '';
  loadSession.mockReset();
});

const open = async (session: Session) => {
  loadSession.mockResolvedValue(session);
  const { mount } = await import('./index.tsx');
  const el = document.createElement('div');
  el.dataset.island = 'quickstart';
  el.innerHTML = '<p>Sign in with Polaris ID</p>';
  document.body.append(el);
  await mount(el);
  return el;
};

describe('the quickstart island', () => {
  it('shows the prerendered page once the session is known to be signed out', async () => {
    const el = await open({ kind: 'out' });
    expect(el.textContent).toContain('Sign in with Polaris ID');
  });

  it('replaces the sign-in view for a developer, and shows only the steps', async () => {
    const el = await open({ kind: 'none', csrf: 'c', siteKey: 's' });
    await vi.waitFor(() => expect(el.textContent).toBe('Steps'));
  });
});
