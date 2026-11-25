import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxManage } from './sandbox-manage.tsx';

vi.mock('../console/turnstile.ts', () => ({ verify: async () => 'tok' }));

const assign = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

const stubLocation = (hash = '') => vi.stubGlobal('location', { ...window.location, hash, assign });
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));

describe('Start over and Delete sandbox', () => {
  it('names what goes before deleting, and cancel leaves it alone', async () => {
    stubLocation();
    const fetchMock = reply(204, {});
    vi.stubGlobal('fetch', fetchMock);
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    expect(screen.queryByRole('region')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    expect(screen.getByText(/Passes, keys, webhooks and logs are deleted/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Passes, keys, webhooks and logs/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes with DELETE and returns to the quickstart', async () => {
    stubLocation();
    const fetchMock = reply(204, {});
    vi.stubGlobal('fetch', fetchMock);
    render(<SandboxManage csrf="csrf-1" siteKey="k" onMade={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/developers/quickstart'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/developer/sandbox');
    expect(init.method).toBe('DELETE');
  });

  it('starts over through the check and hands the new key to the page', async () => {
    stubLocation();
    const fetchMock = reply(201, {
      id: 's2',
      orgSlug: 'dev-new',
      templateId: 't2',
      key: { secret: 'pbp_test_new' },
    });
    vi.stubGlobal('fetch', fetchMock);
    const onMade = vi.fn();
    render(<SandboxManage csrf="c" siteKey="k" onMade={onMade} />);
    await userEvent.click(screen.getByRole('button', { name: /Start over/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Start over' }).at(-1) as HTMLElement,
    );
    await waitFor(() =>
      expect(onMade).toHaveBeenCalledWith(
        { id: 's2', orgSlug: 'dev-new', templateId: 't2' },
        'pbp_test_new',
      ),
    );
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      '/api/v1/developer/sandbox/recreate',
    );
  });

  it('shows the server sentence when it refuses, such as the daily limit', async () => {
    stubLocation();
    vi.stubGlobal(
      'fetch',
      reply(429, { detail: 'You can delete a sandbox 3 times a day. Try again later.' }),
    );
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('3 times a day');
    expect(assign).not.toHaveBeenCalled();
  });

  it('opens the confirm named by the chip menu link', () => {
    stubLocation('#delete-sandbox');
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });
});
