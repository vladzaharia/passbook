import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  reset: vi.fn(),
  reopen: vi.fn(),
  session: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../console/sandbox-actions.ts', () => ({
  ActionError: class ActionError extends Error {
    signInUrl?: string;
    constructor(message: string, signInUrl?: string) {
      super(message);
      this.signInUrl = signInUrl;
    }
  },
  resetSandbox: m.reset,
  reopenSandbox: m.reopen,
}));
vi.mock('../console/session.ts', () => ({ loadSession: m.session }));
vi.mock('../console/turnstile.ts', () => ({ verify: m.verify }));

import { ActionError } from '../console/sandbox-actions.ts';
import { ReopenAction, ResetAction } from './sandbox-actions.tsx';

const ready = { kind: 'ready', csrf: 'c', siteKey: 'k', sandbox: {} };
const closed = (reason: string, until: number | null) =>
  ({ reopenUntil: until, closeReason: reason }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue(ready);
  m.verify.mockResolvedValue('tok');
});

describe('ResetAction', () => {
  it('confirms, resets, and hands the new key up', async () => {
    m.reset.mockResolvedValue({
      secret: 'new',
      deleted: { passes: 1, captures: 2, calls: 3 },
      kept: 2,
      resetsLeft: 2,
    });
    const onKey = vi.fn();
    const onChanged = vi.fn();
    render(<ResetAction onChanged={onChanged} onKey={onKey} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    await waitFor(() => expect(onKey).toHaveBeenCalled());
    expect(m.reset).toHaveBeenCalledWith('c', 'tok');
    expect(onKey.mock.calls[0]?.[0]).toEqual({
      secret: 'new',
      line: 'Reset. Deleted 1 pass, 2 captured events and 3 calls. 2 passes could not be deleted yet. 2 left today.',
    });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('cancels back to idle', async () => {
    render(<ResetAction onChanged={vi.fn()} onKey={vi.fn()} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Reset sandbox' })).toBeNull();
  });

  it('says what is left when the purge ran out of time', async () => {
    m.reset.mockResolvedValue({ more: true, deleted: { passes: 1 } });
    const onKey = vi.fn();
    render(<ResetAction onChanged={vi.fn()} onKey={onKey} panel={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await user.click(screen.getByRole('button', { name: 'Reset sandbox' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Part of the data is left (1 pass');
    expect(onKey).not.toHaveBeenCalled();
  });

  it('shows a step-up with its sign-in link, and a failed check in plain words', async () => {
    m.reset
      .mockRejectedValueOnce(new ActionError('Sign in again.', '/auth/oidc/start'))
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
      .mockRejectedValueOnce(new ActionError('Sign in again.', '/auth/oidc/start'))
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
