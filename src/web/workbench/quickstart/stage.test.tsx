import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  wallets: { state: 'ready' } as { state: string },
  engine: undefined as undefined | (() => string),
  load: vi.fn(),
  copy: vi.fn(),
}));
vi.mock('../../channel-previews/use-wallet-previews.ts', () => ({
  useWalletPreviews: () => m.wallets,
}));
vi.mock('../../pass-card/barcode-engine.ts', () => ({
  getBarcodeEngine: () => m.engine,
  loadBarcodeEngine: () => m.load(),
}));
vi.mock('../../ui/art/buddy.tsx', () => ({ Buddy: () => <i /> }));
vi.mock('../playground/copy.ts', () => ({ copyToClipboard: m.copy }));
vi.mock('../playground/panes.tsx', () => ({
  ApplePane: () => <p>apple-pane</p>,
  PaperPane: () => <p>paper-pane</p>,
  WalletPane: ({ target }: { target: string }) => <p>{target}-pane</p>,
}));
vi.mock('../playground/templates.ts', () => ({ sourceOf: () => ({}) }));
vi.mock('./make-sandbox.tsx', () => ({ MakeSandbox: () => <p>make-sandbox</p> }));
vi.mock('./timeline.tsx', () => ({ rowsOf: () => [], Timeline: () => <p>timeline</p> }));
vi.mock('./use-caught.ts', () => ({ useCaught: () => ({ caught: {}, over: false }) }));

import { Stage } from './stage.tsx';

const pass = { id: 'p', version: 1, previewUrl: 'https://t.example/p/x', startedAt: 0 };
const qOf = (over: Record<string, unknown> = {}) =>
  ({
    pass: null,
    template: null,
    run: { state: 'idle' },
    change: { state: 'idle' },
    client: null,
    rendered: vi.fn(),
    renderedMs: null,
    renderedAt: null,
    session: { kind: 'ready', siteKey: 'k' },
    csrf: 'c',
    sandboxMade: vi.fn(),
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.wallets = { state: 'ready' };
  m.engine = undefined;
  m.load.mockResolvedValue(() => '<svg/>');
});

describe('Stage', () => {
  it('is empty until there is a pass', () => {
    render(<Stage q={qOf()} fix={null} />);
    expect(screen.getByText('timeline')).toBeInTheDocument();
    expect(document.querySelector('.qs-stage-card')).toHaveAttribute('data-state', 'empty');
    expect(document.querySelector('.pill.neutral')).not.toBeNull();
  });

  it('shows the pass in each wallet, reports the first render, and the test link', async () => {
    const q = qOf({ pass, template: {}, renderedMs: 1500, run: { state: 'ok' } });
    render(<Stage q={q} fix={null} />);
    expect(screen.getByText('apple-pane')).toBeInTheDocument();
    expect((q as { rendered: ReturnType<typeof vi.fn> }).rendered).toHaveBeenCalled();
    expect(document.querySelector('.pill.success')).not.toBeNull();
    const user = userEvent.setup();
    for (const [name, pane] of [
      ['Google', 'google-pane'],
      ['Samsung', 'samsung-pane'],
      ['Paper', 'paper-pane'],
    ] as const) {
      await user.click(screen.getByRole('radio', { name }));
      expect(screen.getByText(pane)).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 't.example/p/x' })).toBeInTheDocument();
    await waitFor(() => expect(m.load).toHaveBeenCalled());
  });

  it('draws the QR once the encoder is there, and copies the link', async () => {
    m.engine = () => '<svg/>';
    m.copy.mockResolvedValue(true);
    render(<Stage q={qOf({ pass, template: {} })} fix={null} />);
    expect(screen.getByAltText('QR code of the test preview link')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Copy/ }));
    expect(await screen.findByText(/Copied/)).toBeInTheDocument();
  });

  it('keeps going without the encoder, and does not mark a failed copy', async () => {
    m.load.mockRejectedValue(new Error('no'));
    m.copy.mockResolvedValue(false);
    render(<Stage q={qOf({ pass, template: {} })} fix={null} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Copy/ }));
    expect(screen.queryByText(/Copied/)).toBeNull();
    expect(document.querySelector('.pill.info')).not.toBeNull();
  });

  it('shows what failed, with the repair and the error page', () => {
    render(
      <Stage
        q={qOf({ run: { state: 'fail' } })}
        fix={{ title: 'No template', line: 'Finish setup.', repair: true, code: 'TEMPLATE_GONE' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('No template');
    expect(screen.getByText('make-sandbox')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /.+/ })).toHaveAttribute(
      'href',
      expect.stringContaining('TEMPLATE_GONE'),
    );
    expect(document.querySelector('.pill.danger')).not.toBeNull();
  });
});
