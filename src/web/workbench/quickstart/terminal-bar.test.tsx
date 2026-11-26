import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';

const l = vi.hoisted(() => ({
  heard: [] as unknown[],
  over: false,
  quiet: false,
  again: vi.fn(),
}));
vi.mock('./use-listener.ts', () => ({
  useListener: () => ({ heard: l.heard, over: l.over, quiet: l.quiet, again: l.again }),
}));

import { Stamped, TerminalBar } from './terminal-bar.tsx';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  method: 'POST',
  path: '/api/v1/passes',
  status: 201,
  code: null,
  via: null,
  client: 'curl/8',
  durationMs: 40,
  requestId: 'req_abcdef123456',
  at: 1,
  ...over,
});
const qOf = (over: Record<string, unknown> = {}) =>
  ({
    secret: null,
    input: { attendee: 'x' },
    heardPass: vi.fn(),
    home: { calls: [], keys: [] },
    ...over,
  }) as never;

beforeEach(() => {
  l.heard = [];
  l.over = false;
  l.quiet = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('TerminalBar', () => {
  it('names the three causes once it has been quiet, and offers Run here', async () => {
    l.quiet = true;
    const onHere = vi.fn();
    render(<TerminalBar q={qOf()} active done={false} onHere={onHere} />);
    expect(screen.getByText('Quiet so far.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Run here instead' }));
    expect(onHere).toHaveBeenCalled();
  });

  it('shows no hint before it is quiet', () => {
    render(<TerminalBar q={qOf()} active done={false} />);
    expect(screen.queryByText('Quiet so far.')).toBeNull();
  });

  it('waits for any key, then names the key it listens for', () => {
    const { rerender } = render(<TerminalBar q={qOf()} active done={false} />);
    expect(screen.getByText(/Listening for a call from your sandbox/)).toBeInTheDocument();
    rerender(
      <TerminalBar
        q={qOf({ home: { calls: [], keys: [{ secretPrefix: 'pk_live' }] } })}
        active
        done={false}
      />,
    );
    expect(screen.getByText('pk_live_…')).toBeInTheDocument();
    rerender(<TerminalBar q={qOf({ secret: 'pk_abcdef_secretsecret' })} active done={false} />);
    expect(screen.getByText(/Listening for/)).toBeInTheDocument();
  });

  it('says how to check the key after ten quiet minutes, and listens again', async () => {
    l.over = true;
    render(<TerminalBar q={qOf()} active done={false} />);
    expect(screen.getByText(QS_COPY.made.checkLine)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Listen again' }));
    expect(l.again).toHaveBeenCalled();
  });

  it('shows a pass made from a terminal and tells the page once', () => {
    l.heard = [entry()];
    const q = qOf();
    const { rerender } = render(<TerminalBar q={q} active done={false} />);
    expect(screen.getByText(/From your terminal/)).toBeInTheDocument();
    rerender(<TerminalBar q={q} active done={false} />);
    expect((q as { heardPass: ReturnType<typeof vi.fn> }).heardPass).toHaveBeenCalledTimes(1);
  });

  it('notes another call that worked', () => {
    l.heard = [entry({ method: 'GET', path: '/api/v1/templates', status: 200 })];
    render(<TerminalBar q={qOf()} active done={false} />);
    expect(screen.getByText(/Heard GET \/templates/)).toBeInTheDocument();
  });

  it('reads a refused call from the log and marks what to change', async () => {
    l.heard = [entry({ status: 422, code: 'PASS_INPUT_INVALID' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          responseBody: JSON.stringify({ detail: 'Bad input', issues: [{ path: 'input.seat' }] }),
          requestBody: '{}',
        }),
      ),
    );
    render(<TerminalBar q={qOf()} active done={false} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('input.seat')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'PASS_INPUT_INVALID' })).toBeInTheDocument();
  });

  it('still names the problem when the log has no body', async () => {
    l.heard = [entry({ status: 401, code: 'UNAUTHENTICATED' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 404 })),
    );
    render(<TerminalBar q={qOf()} active done={false} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('after a reload, shows the pass call the log kept', () => {
    render(
      <TerminalBar
        q={qOf({ home: { calls: [entry({ id: 'old' })], keys: [] } })}
        active={false}
        done
      />,
    );
    expect(screen.getByText(/From your terminal/)).toBeInTheDocument();
  });
});

describe('Stamped', () => {
  it('marks a failure and leaves out an unknown client', () => {
    render(<Stamped entry={entry({ status: 500, client: null }) as never} />);
    expect(document.querySelector('.stamp.bad')).not.toBeNull();
  });
});
