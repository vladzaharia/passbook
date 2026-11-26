import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reset: vi.fn(),
  mint: vi.fn(),
  /** What the panel reports when the operation it follows ends well. */
  done: { current: null as unknown },
  reopen: vi.fn(),
  session: vi.fn(),
  verify: vi.fn(),
  copy: vi.fn(),
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
vi.mock('../ui/sandbox-operation.tsx', async (importActual) => ({
  ...(await importActual<typeof import('../ui/sandbox-operation.tsx')>()),
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
    useEffect(() => {
      if (m.done.current) onSucceeded(m.done.current);
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
vi.mock('../playground/copy.ts', () => ({ copyToClipboard: m.copy }));

import { ActionError } from '../console/sandbox-actions.ts';
import { NewKey, ReopenAction, ResetAction } from './sandbox-actions.tsx';

const ready = { kind: 'ready', csrf: 'c', siteKey: 'k', sandbox: {} };
const closed = (reason: string, until: number | null) =>
  ({ reopenUntil: until, closeReason: reason }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.done.current = null;
  m.session.mockResolvedValue(ready);
  m.verify.mockResolvedValue('tok');
});

describe('NewKey', () => {
  it('shows the key once and copies it as an env line', async () => {
    m.copy.mockResolvedValue(true);
    const onClose = vi.fn();
    render(<NewKey done secret="pk_1" line="Reset." onClose={onClose} />);
    expect(screen.getByText('PASSBOOK_KEY=pk_1')).toBeInTheDocument();
    expect(screen.getByText('Shown once.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(m.copy).toHaveBeenCalledWith('PASSBOOK_KEY=pk_1\n');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('has no key box without a secret', () => {
    render(<NewKey done={false} secret={null} line="Reopened." onClose={() => undefined} />);
    expect(screen.queryByText(/PASSBOOK_KEY/)).toBeNull();
  });
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
