import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  loadIndex: vi.fn(),
  loadFile: vi.fn(),
  retain: vi.fn(() => () => undefined),
}));
vi.mock('../data.ts', () => ({ loadIndex: m.loadIndex, loadFile: m.loadFile }));
vi.mock('../token.ts', () => ({ retain: m.retain }));
vi.mock('./console.tsx', () => ({
  OpConsole: ({ op, mode, prefill }: { op: { id: string }; mode: string; prefill?: unknown }) => (
    <p>
      console {op.id} {mode} {prefill ? 'prefilled' : 'plain'}
    </p>
  ),
}));
vi.mock('./picker.tsx', () => ({
  Picker: ({
    index,
    current,
    onPick,
  }: {
    index: { groups: { items: { id: string; title: string }[] }[] };
    current: string | null;
    onPick: (i: { id: string; title: string; slug: string; anchor: string }) => void;
  }) => (
    <div>
      <span>current {current}</span>
      {index.groups.flatMap((g) =>
        g.items.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => onPick(i as { id: string; title: string; slug: string; anchor: string })}
          >
            pick {i.id}
          </button>
        )),
      )}
    </div>
  ),
}));

import { RunApp } from './run-app.tsx';

const sandbox = { id: 's', orgId: 'org-1', orgSlug: 'o', templateId: 't' };
const ready = { kind: 'ready', csrf: 'c', sandbox, siteKey: 'k' } as const;
const index = {
  codes: ['X'],
  groups: [
    {
      items: [
        { id: 'a', title: 'First', slug: 'passes', anchor: 'a' },
        { id: 'b', title: 'Second', slug: 'passes', anchor: 'b' },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.loadIndex.mockResolvedValue(index);
  m.loadFile.mockResolvedValue({ origin: 'https://x', ops: [{ id: 'a' }] });
  location.hash = '';
});

describe('RunApp with a sandbox', () => {
  it('says a closed sandbox is read-only', () => {
    render(<RunApp session={{ kind: 'closed', csrf: 'c', siteKey: '' }} mode="op" />);
    expect(screen.getByText('Your sandbox is closed')).toBeInTheDocument();
  });

  it('loads the operation of an operation page, and keeps the token', async () => {
    render(<RunApp session={ready} mode="op" slug="passes" opId="a" />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(await screen.findByText('console a op plain')).toBeInTheDocument();
    expect(m.retain).toHaveBeenCalledWith('c');
  });

  it('says so when the operation is not in the file or the file did not load', async () => {
    const { unmount } = render(<RunApp session={ready} mode="op" slug="passes" opId="zzz" />);
    expect(await screen.findByText('Could not load this operation')).toBeInTheDocument();
    unmount();
    m.loadFile.mockRejectedValue(new Error('x'));
    render(<RunApp session={ready} mode="sheet" slug="passes" opId="a" />);
    expect(await screen.findByText('Could not load this operation')).toBeInTheDocument();
  });

  it('the console page starts on the hashed operation and follows the picker', async () => {
    location.hash = '#b';
    m.loadFile.mockResolvedValue({ origin: 'https://x', ops: [{ id: 'a' }, { id: 'b' }] });
    render(<RunApp session={ready} mode="console" />);
    expect(await screen.findByText('current b')).toBeInTheDocument();
    expect(await screen.findByText(/console b console/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the reference' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'pick a' }));
    await waitFor(() => expect(screen.getByText('current a')).toBeInTheDocument());
    expect(location.hash).toBe('#a');
  });
});
