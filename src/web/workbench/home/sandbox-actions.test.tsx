import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reset: vi.fn(),
  mint: vi.fn(),
  /** What the panel reports when the operation it follows ends well. */
  done: { current: null as unknown },
  reopen: vi.fn(),
  session: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../console/sandbox-actions.ts', () => ({
  ActionError: class ActionError extends Error {
    signInUrl?: string;
    operationId?: string;
    constructor(message: string, extra: { signInUrl?: string; operationId?: string } = {}) {
      super(message);
      this.signInUrl = extra.signInUrl;
      this.operationId = extra.operationId;
    }
  },
  startReset: m.reset,
  mintKey: m.mint,
  reopenSandbox: m.reopen,
}));
// The panel itself is the kit's (its own tests); here it stands for an operation that ends when told to.
vi.mock('../../developers/ui/sandbox-operation.tsx', async (importActual) => ({
  ...(await importActual<typeof import('../../developers/ui/sandbox-operation.tsx')>()),
  SandboxOperations: ({ children }: { children: ReactNode }) => children,
  SandboxOperation: ({
    id,
    onSucceeded,
    onClose,
  }: {
    id: string;
    onSucceeded: (op: unknown) => void;
    onClose: () => void;
  }) => {
    // Once, as the real panel tells it.
    const told = useRef(false);
    useEffect(() => {
      if (!m.done.current || told.current) return;
      told.current = true;
      onSucceeded(m.done.current);
    }, [onSucceeded]);
    return (
      <div>
        <p>Following {id}</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  },
}));
vi.mock('../console/session.ts', () => ({ loadSession: m.session }));
vi.mock('../console/turnstile.ts', () => ({ verify: m.verify }));

import { fixtureOperation, SANDBOX_CREATE } from '../../ui/operation/fixtures.test-support.ts';
import { seedOperation } from '../../ui/operation/index.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import { ActionError } from '../console/sandbox-actions.ts';
import { ReopenAction, ResetAction } from './sandbox-actions.tsx';

const ready = { kind: 'ready', csrf: 'c', siteKey: 'k', sandbox: {} };
const closed = (reason: string, until: number | null) =>
  ({ reopenUntil: until, closeReason: reason }) as never;

const DONE_RESET = {
  id: 'op-r',
  kind: 'sandbox.reset',
  steps: [],
  result: {
    href: null,
    ids: { passes: '1', captures: '2', calls: '3', kept: '0', resetsLeft: '2' },
  },
};
const search = () => window.location.search;

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/developers');
  resetOperationCache();
  m.done.current = null;
  m.session.mockResolvedValue(ready);
  m.verify.mockResolvedValue('tok');
});

describe('ResetAction', () => {
  it('confirms, follows the operation, mints the key once and hands it up with what was deleted', async () => {
    m.reset.mockResolvedValue({ id: 'op-r', kind: 'sandbox.reset' });
    m.mint.mockResolvedValue('new');
    m.done.current = {
      id: 'op-r',
      kind: 'sandbox.reset',
      steps: [],
      result: {
        href: null,
        ids: { passes: '1', captures: '2', calls: '3', kept: '2', resetsLeft: '2' },
      },
    };
    const onKey = vi.fn();
    const onChanged = vi.fn();
    render(<ResetAction onChanged={onChanged} onKey={onKey} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    await waitFor(() => expect(onKey).toHaveBeenCalled());
    expect(m.reset).toHaveBeenCalledWith('c', 'tok');
    expect(m.mint).toHaveBeenCalledWith('c');
    expect(onKey.mock.calls[0]?.[0]).toEqual({
      secret: 'new',
      line: 'Reset. Deleted 1 pass, 2 events and 3 calls. 2 passes could not be deleted yet. 2 resets left today.',
    });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('keeps the run in the address, so a reload resumes the panel without asking again', async () => {
    m.reset.mockResolvedValue({ id: 'op-r', kind: 'sandbox.reset' });
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    await screen.findByText('Following op-r');
    expect(search()).toBe('?op=op-r');
  });

  it('resumes the run a reload names, in the confirm, and starts nothing', async () => {
    window.history.replaceState(null, '', '/developers?op=op-r');
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const region = await screen.findByRole('region', { name: 'Reset this sandbox?' });
    expect(await screen.findByText('Following op-r')).toBeInTheDocument();
    expect(region).not.toHaveTextContent('Cancel');
    expect(m.reset).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it('mints the key when a resumed run ended well, once, and drops ?op', async () => {
    window.history.replaceState(null, '', '/developers?op=op-r');
    m.done.current = DONE_RESET;
    m.mint.mockResolvedValue('new');
    const onKey = vi.fn();
    render(<ResetAction onChanged={vi.fn()} onKey={onKey} panel={null} />);
    await waitFor(() => expect(onKey).toHaveBeenCalled());
    expect(m.mint).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0]?.[0]).toMatchObject({ secret: 'new' });
    expect(search()).toBe('');
  });

  it('says the key was shown once, and shows no sheet, when it was minted before', async () => {
    window.history.replaceState(null, '', '/developers?op=op-r');
    m.done.current = DONE_RESET;
    m.mint.mockResolvedValue(null);
    const onKey = vi.fn();
    render(<ResetAction onChanged={vi.fn()} onKey={onKey} panel={null} />);
    await waitFor(() => expect(onKey).toHaveBeenCalled());
    expect(onKey.mock.calls[0]?.[0]).toEqual({
      secret: null,
      shown: true,
      line: 'Reset. Deleted 1 pass, 2 events and 3 calls. 2 resets left today. Your key was shown once. Roll it to get a new one.',
    });
    expect(search()).toBe('');
  });

  it('keeps the panel and offers Try again when the key call fails', async () => {
    window.history.replaceState(null, '', '/developers?op=op-r');
    m.done.current = DONE_RESET;
    m.mint.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('new');
    const onKey = vi.fn();
    render(<ResetAction onChanged={vi.fn()} onKey={onKey} panel={null} />);
    expect(await screen.findByText(/The new key did not arrive/)).toBeInTheDocument();
    expect(onKey).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onKey).toHaveBeenCalled());
    expect(onKey.mock.calls[0]?.[0]).toMatchObject({ secret: 'new' });
  });

  it('leaves a ?op that names another kind to its owner', async () => {
    window.history.replaceState(null, '', '/developers?op=op-c');
    seedOperation(fixtureOperation(SANDBOX_CREATE, { status: 'running', id: 'op-c' }));
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    expect(search()).toBe('?op=op-c');
  });

  it('shows the live operation in the confirm, and Close leaves it', async () => {
    m.reset.mockResolvedValue({ id: 'op-r', kind: 'sandbox.reset' });
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    const region = await screen.findByRole('region', { name: 'Reset this sandbox?' });
    expect(region).toHaveTextContent('Following op-r');
    expect(screen.queryByRole('button', { name: 'Reset sandbox' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('follows a reset that is already running instead of showing an error', async () => {
    m.reset.mockRejectedValue(new ActionError('Already.', { operationId: 'op-run' }));
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    expect(await screen.findByText('Following op-run')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels back to idle', async () => {
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Reset sandbox' })).toBeNull();
  });

  it('shows a step-up with its sign-in link, and a failed check in plain words', async () => {
    m.reset
      .mockRejectedValueOnce(new ActionError('Sign in again.', { signInUrl: '/auth/oidc/start' }))
      .mockRejectedValueOnce(new Error('x'));
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    expect(await screen.findByRole('link', { name: 'Continue to Polaris ID' })).toHaveAttribute(
      'href',
      '/auth/oidc/start',
    );
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    expect(await screen.findByText(/The check did not pass/)).toBeInTheDocument();
  });

  it('asks for a reload when the session is not ready', async () => {
    m.session.mockResolvedValue({ kind: 'out' });
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    expect(await screen.findByText(/Reload and try again/)).toBeInTheDocument();
  });

  it('puts the confirm in the panel slot', async () => {
    const panel = document.createElement('div');
    document.body.append(panel);
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={panel} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reset' }));
    expect(panel.querySelector('section')).not.toBeNull();
    panel.remove();
  });
});

describe('ReopenAction', () => {
  it('shows nothing outside the window or after an admin closed it', () => {
    const { container, rerender } = render(
      <ReopenAction sandbox={closed('idle', null)} onChanged={vi.fn()} onKey={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<ReopenAction sandbox={closed('admin', 5)} onChanged={vi.fn()} onKey={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reopens and hands the replaced key up', async () => {
    m.reopen.mockResolvedValue({ secret: 'k2' });
    const onKey = vi.fn();
    const onChanged = vi.fn();
    render(<ReopenAction sandbox={closed('idle', 5)} onChanged={onChanged} onKey={onKey} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(m.reopen).toHaveBeenCalledWith('c');
    expect(onKey).toHaveBeenCalledWith({ secret: 'k2', line: 'Reopened. Your key was replaced.' });
  });

  it('says what went wrong, with the step-up link when there is one', async () => {
    m.reopen
      .mockRejectedValueOnce(new ActionError('Sign in again.', { signInUrl: '/auth/oidc/start' }))
      .mockRejectedValueOnce(new Error('x'));
    render(<ReopenAction sandbox={closed('idle', 5)} onChanged={vi.fn()} onKey={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('link', { name: 'Continue to Polaris ID' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });

  it('asks to sign in again when the session is gone', async () => {
    m.session.mockResolvedValue({ kind: 'out' });
    render(<ReopenAction sandbox={closed('idle', 5)} onChanged={vi.fn()} onKey={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('Sign in again.')).toBeInTheDocument();
  });
});
