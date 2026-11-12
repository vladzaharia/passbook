import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import {
  deferredPreview,
  type Pending,
  renderInApp,
  response,
  Stage,
} from './scan-stage-test-fixtures.ts';

afterEach(() => vi.unstubAllGlobals());

async function pickPass(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('combobox', { name: /^Pass/ }));
  await user.type(await screen.findByPlaceholderText('Search passes'), name.slice(0, 4));
  await user.click(await screen.findByRole('option', { name }));
}

describe('scan preview stage', () => {
  it('does not request a real pass without an organization', () => {
    const requests = deferredPreview();
    render(<Stage orgId={null} />);
    expect(screen.getByText('Real-pass preview needs an organization.')).toBeVisible();
    expect(requests).toHaveLength(0);
  });

  it('uses the documented GET and discards role and pass scopes before requests finish', async () => {
    const user = userEvent.setup();
    const requests = deferredPreview();
    renderInApp(<Stage />);
    await user.click(await screen.findByRole('radio', { name: 'Manager' }));
    await user.click(screen.getByRole('combobox', { name: 'Sample: Synthetic sample' }));
    await user.click(screen.getByRole('option', { name: 'Real pass' }));
    await pickPass(user, 'Pass one');
    await waitFor(() => expect(requests).toHaveLength(1));
    const first = requests[0] as Pending;
    expect(first.url.pathname).toBe('/api/v1/scan-display/preview');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      orgId: 'org1',
      mode: 'test',
      templateId: 'tpl1',
      passId: 'pass-one',
      role: 'manager',
    });
    expect(first.init?.method).toBe('GET');
    expect(new Headers(first.init?.headers).get('x-passbook-mode')).toBe('test');
    expect(screen.getByText(/Loading real pass · showing a synthetic sample/)).toBeVisible();
    await act(async () => first.answer(response('Manager Person', 'Manager-only tier')));
    await screen.findByText('Manager-only tier');
    expect(screen.queryByText('Raw-only sentinel')).not.toBeInTheDocument();
    expect(screen.queryByText('never@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('never-a-barcode')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Door' }));
    expect(screen.queryByText('Manager Person')).not.toBeInTheDocument();
    expect(screen.queryByText('Manager-only tier')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading real pass · showing a synthetic sample/)).toBeVisible();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.url.searchParams.get('role')).toBe('door');
    fireEvent.click(screen.getByRole('radio', { name: 'Desk' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () => requests[1]?.answer(response('Stale Door', 'Not visible')));
    expect(screen.queryByText('Stale Door')).not.toBeInTheDocument();
    await act(async () => requests[2]?.answer(response('Desk Person', 'Not visible')));
    await screen.findByText('Desk Person');
    expect(screen.queryByText('Not visible')).not.toBeInTheDocument();

    await pickPass(user, 'Pass two');
    expect(screen.queryByText('Desk Person')).not.toBeInTheDocument();
    expect(screen.getByText(/Loading real pass · showing a synthetic sample/)).toBeVisible();
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]?.url.searchParams.get('passId')).toBe('pass-two');
    await act(async () =>
      requests[3]?.answer(json({ title: 'Not found', code: 'not_found' }, 404)),
    );
    await screen.findByText(/Real pass unavailable · showing a synthetic sample/);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That pass is not in this template and mode. Pick another.',
    );
    expect(screen.getByText('Alex')).toBeVisible();
    expect(screen.queryByText('Desk Person')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(requests).toHaveLength(5));
    expect(requests[4]?.url.searchParams.get('passId')).toBe('pass-two');
    await act(async () => requests[4]?.answer(response('Retry Person', 'Not visible')));
    await screen.findByText('Retry Person');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
