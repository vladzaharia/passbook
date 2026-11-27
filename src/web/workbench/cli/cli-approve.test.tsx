import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_MISMATCH_WARNING, CLI_PAGE } from '@/shared/copy/cli.ts';
import { ApiError } from '../../lib/errors.ts';
import type { WbContext } from '../host/contexts.ts';
import type { CliReview } from './cli-api.ts';

const api = vi.hoisted(() => ({
  lookup: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
}));
vi.mock('./cli-api.ts', async (original) => ({
  ...(await original<typeof import('./cli-api.ts')>()),
  cliApi: api,
}));

const contexts: WbContext[] = [
  { orgId: 'sb', name: 'Dev sandbox', kind: 'sandbox', tools: [], closed: false, timeZone: 'UTC' },
  { orgId: 'acme', name: 'Acme', kind: 'org', tools: [], closed: false, timeZone: 'UTC' },
];
vi.mock('../host/contexts.ts', () => ({ useWorkbenchContexts: () => ({ data: contexts }) }));
vi.mock('../../lib/session.ts', () => ({
  useSession: () => ({ authed: { csrfToken: 'csrf-1' } }),
}));

import { ARM_MS, CliApprovePage } from './cli-approve.tsx';

const review = (over: Partial<CliReview> = {}): CliReview => ({
  id: 's1',
  client: { name: 'passbook-cli', version: '0.2.0', os: 'macOS' },
  startedAt: Date.now() - 120_000,
  startCountry: 'US',
  startCity: 'Seattle',
  mismatch: false,
  account: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
  accountMismatch: false,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.lookup.mockResolvedValue(review());
  api.approve.mockResolvedValue(undefined);
  api.deny.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const type = async (code: string) => {
  fireEvent.change(screen.getByLabelText(CLI_PAGE.code), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: CLI_PAGE.next }));
  await screen.findByText(CLI_PAGE.account);
};

describe('the CLI approve page', () => {
  it('starts with one empty field and nothing from the URL', () => {
    window.history.replaceState(null, '', '/workbench/cli?code=BCDF-GHJK#code=BCDFGHJK');
    render(<CliApprovePage />);
    expect(screen.getByLabelText(CLI_PAGE.code)).toHaveValue('');
    expect(api.lookup).not.toHaveBeenCalled();
  });

  it('shows the account, the network and the device as reported, with the mismatch warning', async () => {
    api.lookup.mockResolvedValue(review({ mismatch: true }));
    render(<CliApprovePage />);
    await type('bcdf-ghjk');
    expect(api.lookup).toHaveBeenCalledWith('BCDF-GHJK', 'csrf-1');
    expect(screen.getByText(/Ada · ada@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/from Seattle, US/)).toBeInTheDocument();
    expect(screen.getByText(/passbook-cli 0.2.0 on macOS/)).toBeInTheDocument();
    expect(screen.getByText(CLI_PAGE.device)).toBeInTheDocument();
    expect(screen.getByText(CLI_MISMATCH_WARNING)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: CLI_PAGE.notYou })).toHaveAttribute(
      'href',
      expect.stringContaining('prompt=login'),
    );
  });

  it('renders what the device reports as text', async () => {
    api.lookup.mockResolvedValue(
      review({ client: { name: '<img src=x onerror=alert(1)>', version: '1', os: 'linux' } }),
    );
    const { container } = render(<CliApprovePage />);
    await type('BCDFGHJK');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });

  it('arms Approve after 3 seconds, and approves the picked context', async () => {
    render(<CliApprovePage />);
    await type('BCDFGHJK');
    const approve = screen.getByRole('button', { name: /^Approve/ });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(api.approve).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ARM_MS + 500);
    });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('s1', 'sb', 'csrf-1'));
    expect(await screen.findByText(CLI_PAGE.approved)).toBeInTheDocument();
  });

  it('denies without waiting', async () => {
    render(<CliApprovePage />);
    await type('BCDFGHJK');
    fireEvent.click(screen.getByRole('button', { name: CLI_PAGE.deny }));
    await waitFor(() => expect(api.deny).toHaveBeenCalledWith('s1', 'csrf-1'));
    expect(await screen.findByText(CLI_PAGE.denied)).toBeInTheDocument();
  });

  it('says a wrong code once, in the field', async () => {
    api.lookup.mockRejectedValue(
      new ApiError({ status: 404, code: 'CLI_CODE_NOT_FOUND', detail: 'No such code.' }),
    );
    render(<CliApprovePage />);
    fireEvent.change(screen.getByLabelText(CLI_PAGE.code), { target: { value: 'XXXX' } });
    fireEvent.click(screen.getByRole('button', { name: CLI_PAGE.next }));
    expect(await screen.findByText('No such code.')).toBeInTheDocument();
  });

  it('keeps the typed code across a step-up, and takes it back once', async () => {
    api.approve.mockRejectedValue(
      new ApiError({ status: 403, code: 'STEP_UP_REQUIRED', detail: 'Sign in again.' }),
    );
    render(<CliApprovePage />);
    await type('BCDFGHJK');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ARM_MS + 500);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(sessionStorage.getItem('wb-cli-code')).toBe('BCDFGHJK'));
    render(<CliApprovePage />);
    await waitFor(() => expect(api.lookup).toHaveBeenLastCalledWith('BCDFGHJK', 'csrf-1'));
    expect(sessionStorage.getItem('wb-cli-code')).toBeNull();
  });
});
