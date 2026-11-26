import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import type { Session } from '../console/session.ts';

const loadSession = vi.fn<() => Promise<Session>>();
vi.mock('../console/session.ts', () => ({ loadSession: () => loadSession() }));
vi.mock('../workbench/api.ts', () => ({ fetchHome: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = '';
  loadSession.mockReset();
});

const open = async (session: Session) => {
  loadSession.mockResolvedValue(session);
  const { mount } = await import('./index.tsx');
  const el = document.createElement('div');
  document.body.append(el);
  await mount(el);
  return el;
};

describe('the keys page without keys to list', () => {
  it('offers Create sandbox when there is no sandbox, under the frame heading', async () => {
    await open({ kind: 'none', csrf: 'c', siteKey: 's' });
    expect(await screen.findByText(KEYS_COPY.noSandbox)).toBeTruthy();
    // The bench frame has the page's one h1.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('link', { name: KEYS_COPY.create }).getAttribute('href')).toContain(
      '#sandbox',
    );
  });

  it('says the keys stopped for a closed sandbox', async () => {
    await open({ kind: 'closed', csrf: 'c', siteKey: '' });
    expect(await screen.findByText(KEYS_COPY.closed)).toBeTruthy();
  });

  it('shows an error with Retry, not an empty state, when the sandbox did not load', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...location, reload });
    await open({ kind: 'failed', csrf: 'c' });
    expect(await screen.findByText(KEYS_COPY.failed)).toBeTruthy();
    expect(screen.queryByText(KEYS_COPY.noSandbox)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it('draws nothing when signed out: the prerendered card stays', async () => {
    const el = await open({ kind: 'out' });
    expect(el.childElementCount).toBe(0);
  });
});
