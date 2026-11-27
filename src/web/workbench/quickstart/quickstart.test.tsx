import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  refresh: vi.fn(),
  beacon: vi.fn(),
}));
vi.mock('./use-quickstart.ts', () => ({ useQuickstart: () => q.value }));
vi.mock('./beacon.ts', () => ({ beacon: q.beacon }));
vi.mock('./sandbox-step.tsx', () => ({
  SandboxStep: ({ state, onNext }: { state: string; onNext: () => void }) => (
    <button type="button" data-state={state} onClick={onNext}>
      sandbox-step
    </button>
  ),
}));
vi.mock('./call-step.tsx', () => ({ RunStep: () => <p>run-step</p> }));
vi.mock('./change-step.tsx', () => ({ ChangeStep: () => <p>change-step</p> }));
vi.mock('./hear-step.tsx', () => ({
  HearStep: ({ onFinish }: { onFinish: () => void }) => (
    <button type="button" onClick={onFinish}>
      finish
    </button>
  ),
}));
vi.mock('./done.tsx', () => ({ Done: () => <p>done-page</p> }));
vi.mock('./stage.tsx', () => ({
  Stage: ({ fix }: { fix: unknown }) => <p>stage {fix ? 'with fix' : 'plain'}</p>,
}));

import { Quickstart } from './quickstart.tsx';

const base = (over: Record<string, unknown> = {}) => ({
  progress: (over.home as { progress?: unknown } | undefined)?.progress ?? null,
  session: { kind: 'ready' },
  csrf: 'c',
  sandbox: { id: 's' },
  templateId: 't',
  secret: null,
  run: { state: 'idle' },
  skew: 0,
  home: null,
  refresh: q.refresh,
  ...over,
});
const ready = { kind: 'ready', csrf: 'c', sandbox: { id: 's' }, siteKey: 'k' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  q.value = base();
});

describe('Quickstart', () => {
  it('shows the five steps and the stage while the track runs', async () => {
    q.value = base({ home: { state: 'open', progress: { startedAt: 1, passAt: null } } });
    render(<Quickstart session={ready} />);
    expect(screen.getByText('run-step')).toBeInTheDocument();
    expect(await screen.findByText('stage plain')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sandbox-step' })).toHaveAttribute(
      'data-state',
      'done',
    );
  });

  it('marks the line to change when the run was refused', async () => {
    q.value = base({
      run: { state: 'fail', problem: { status: 422, code: 'PASS_INPUT_INVALID', detail: '' } },
    });
    render(<Quickstart session={ready} />);
    expect(await screen.findByText('stage with fix')).toBeInTheDocument();
  });

  it('marks a sandbox without a template as something to finish', async () => {
    q.value = base({ templateId: null });
    render(<Quickstart session={ready} />);
    expect(await screen.findByText('stage with fix')).toBeInTheDocument();
  });

  it('a closed sandbox has an empty stage', () => {
    q.value = base({ session: { kind: 'closed' } });
    render(<Quickstart session={{ kind: 'closed', csrf: 'c', siteKey: '' }} />);
    expect(screen.queryByText(/^stage/)).toBeNull();
  });

  it('opens on the finished page when the track was already done', async () => {
    q.value = base({ home: { state: 'open', progress: { startedAt: 1, doneAt: 5, passAt: 2 } } });
    render(<Quickstart session={ready} />);
    expect(await screen.findByText('done-page')).toBeInTheDocument();
  });

  it('finishing tells the funnel and shows the finished page', async () => {
    vi.useFakeTimers();
    q.value = base({
      home: { state: 'open', progress: { startedAt: 1, doneAt: null, passAt: 2, changeAt: 3 } },
    });
    render(<Quickstart session={ready} />);
    act(() => screen.getByRole('button', { name: 'finish' }).click());
    q.value = base({
      home: { state: 'open', progress: { startedAt: 1, doneAt: 9, passAt: 2, changeAt: 3 } },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3100));
    expect(q.beacon).toHaveBeenCalledWith('c', 'home');
    expect(q.refresh).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reads the home again every three seconds while the pass is made and the track is open', async () => {
    vi.useFakeTimers();
    q.value = base({ home: { state: 'open', progress: { startedAt: 1, passAt: 2 } } });
    render(<Quickstart session={ready} />);
    await act(async () => vi.advanceTimersByTimeAsync(3100));
    expect(q.refresh).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
