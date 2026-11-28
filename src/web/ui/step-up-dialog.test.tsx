import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api } from '../lib/api.ts';
import { dismissStepUp } from '../lib/step-up.ts';
import { stepUpExit } from '../lib/step-up-exit.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';

const STALE = () =>
  new Response(
    JSON.stringify({
      type: 'about:blank#STEP_UP_REQUIRED',
      title: 'STEP_UP_REQUIRED',
      status: 403,
      code: 'STEP_UP_REQUIRED',
      detail: 'Sign in again to confirm it is you.',
      signInUrl: '/auth/oidc/start?prompt=login&max_age=0&next=%2Fadmin',
    }),
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );

afterEach(() => {
  dismissStepUp();
  vi.restoreAllMocks();
});

describe('step-up dialog', () => {
  it('asks to confirm, round-trips to the same page and does not replay the action', async () => {
    const go = vi.spyOn(stepUpExit, 'go').mockImplementation(() => {});
    let calls = 0;
    const { fetchMock } = await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json({ items: [] }),
        '/api/v1/me/sessions': () => json({ items: [] }),
        '/api/v1/api-keys': () => {
          calls += 1;
          return STALE();
        },
      },
    });
    await act(async () => {
      await api.post('/api/v1/api-keys', z.unknown(), { name: 'k' }).catch(() => {});
    });
    expect(
      await screen.findByRole('alertdialog', { name: "Confirm it's you" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Polaris ID' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const href = new URL(String(go.mock.calls[0]?.[0]), 'http://localhost');
    expect(href.pathname).toBe('/auth/oidc/start');
    expect(href.searchParams.get('prompt')).toBe('login');
    expect(href.searchParams.get('max_age')).toBe('0');
    expect(href.searchParams.get('next')).toBe('/');
    // The refused call is not repeated.
    expect(calls).toBe(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api-keys'))).toHaveLength(1);
  });

  it('shows one message: the screen toast for the same refusal is dropped', async () => {
    const { toast } = await import('./toaster.tsx');
    const { ApiError } = await import('../lib/errors.ts');
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json({ items: [] }),
        '/api/v1/me/sessions': () => json({ items: [] }),
      },
    });
    await act(async () => {
      toast.error(new ApiError({ status: 403, code: 'STEP_UP_REQUIRED' }), 'Could not close');
    });
    expect(screen.queryByText('Could not close')).toBeNull();
    await act(async () => {
      toast.error(new ApiError({ status: 403, code: 'FORBIDDEN' }), 'Could not rename');
    });
    expect(await screen.findByText('Could not rename')).toBeInTheDocument();
  });

  it('stays closed for other refusals', async () => {
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json({ items: [] }),
        '/api/v1/me/sessions': () => json({ items: [] }),
        '/api/v1/api-keys': () => problem(403, 'FORBIDDEN', 'No.'),
      },
    });
    await act(async () => {
      await api.post('/api/v1/api-keys', z.unknown(), { name: 'k' }).catch(() => {});
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('step-up sheet size', () => {
  it('opens as a bottom sheet with the same confirm', async () => {
    const { requestStepUp } = await import('../lib/step-up.ts');
    const { render } = await import('@testing-library/react');
    const { StepUpDialog } = await import('./step-up-dialog.tsx');
    const go = vi.spyOn(stepUpExit, 'go').mockImplementation(() => {});
    render(<StepUpDialog size="sheet" />);
    act(() => requestStepUp('/auth/oidc/start?prompt=login&max_age=0'));
    expect(await screen.findByRole('dialog', { name: "Confirm it's you" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with Polaris ID' }));
    expect(go).toHaveBeenCalledTimes(1);
  });
});
