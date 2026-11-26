import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxManage } from './sandbox-manage.tsx';

vi.mock('../console/turnstile.ts', () => ({ verify: async () => 'tok' }));

const assign = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

const stubLocation = (hash = '') =>
  vi.stubGlobal('location', {
    ...window.location,
    pathname: '/developers/quickstart',
    search: '',
    hash,
    assign,
  });
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
      orgId: 'org-2',
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
        { id: 's2', orgId: 'org-2', orgSlug: 'dev-new', templateId: 't2' },
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

  it('opens the confirm when the hash changes on the page, and again for the same choice', async () => {
    stubLocation();
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    expect(screen.queryByText('Delete this sandbox?')).toBeNull();
    // The chip menu link on the quickstart: only the hash changes.
    stubLocation('#delete-sandbox');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete this sandbox?')).toBeNull();
    stubLocation('#delete-sandbox');
    act(() => {
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });

  it('brings the confirm into view and focuses it', () => {
    stubLocation('#delete-sandbox');
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Delete this sandbox?' }),
    );
  });

  it('shows the buddy working while it deletes, and stays that way until the page leaves', async () => {
    stubLocation();
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = r))),
    );
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Deleting your sandbox');
    expect(status.querySelector('svg.wnote-face')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    release(new Response('{}', { status: 200 }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/developers/quickstart'));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows a failure in the confirm and lets the person try again', async () => {
    stubLocation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't reach PassBook");
    expect(screen.getByRole('region').contains(alert)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the choice through the step-up sign-in and reopens the confirm after it', async () => {
    stubLocation();
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      reply(403, {
        detail: 'Sign in again to do this.',
        code: 'STEP_UP_REQUIRED',
        signInUrl: '/auth/oidc/start?prompt=login',
      }),
    );
    const { unmount } = render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /Delete sandbox/ }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete sandbox' }).at(-1) as HTMLElement,
    );
    const link = await screen.findByRole('link', { name: 'Continue to Polaris ID' });
    link.addEventListener('click', (e) => e.preventDefault());
    await userEvent.click(link);
    unmount();
    render(<SandboxManage csrf="c" siteKey="k" onMade={() => undefined} />);
    expect(screen.getByText('Delete this sandbox?')).toBeTruthy();
  });
});
