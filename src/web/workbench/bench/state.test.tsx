import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveIndicator, useLiveState } from './live.tsx';
import { BenchSkeleton } from './skeleton.tsx';
import { BenchGate, BenchState } from './state.tsx';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('bench states', () => {
  it('acts each moment out with its own scene and prop, one buddy per card', () => {
    const scenes = [
      ['no-sandbox', 'wave', 'No sandbox yet'],
      ['closed', 'beat', 'Sandbox closed'],
      ['console-idle', 'nudge', 'Run the request.'],
      ['webhooks-idle', 'listen', 'Listening for events'],
      ['logs-idle', 'inspect', 'Waiting for your first call'],
      ['keys-none', 'tuck', 'No keys'],
      ['no-match', 'search', 'No matches'],
      ['failed', 'plug', 'Did not load'],
    ] as const;
    for (const [scene, act, title] of scenes) {
      const html = renderToStaticMarkup(<BenchState scene={scene} />);
      const root = document.createElement('div');
      root.innerHTML = html;
      const card = root.querySelector('section');
      expect(card?.getAttribute('data-scene'), scene).toBe(scene);
      const buddies = card?.querySelectorAll('[data-scene]') ?? [];
      expect(buddies.length, scene).toBe(1);
      expect(buddies[0]?.getAttribute('data-scene'), scene).toBe(act);
      expect(root.querySelector('h2')?.textContent, scene).toBe(title);
    }
  });

  it('a failed load carries Retry next to its own action', () => {
    const onRetry = vi.fn();
    render(
      <BenchState scene="failed" onRetry={onRetry}>
        <a href="/developers/status">Status</a>
      </BenchState>,
    );
    const card = screen.getByRole('region', { name: 'Did not load' });
    expect(card.textContent).toContain('Status');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('signed out is the BX2 gate with the tool line and the way back', () => {
    render(<BenchGate tool="logs" />);
    const signIn = screen.getByRole('link', { name: 'Sign in' });
    expect(signIn.getAttribute('href')).toBe('/login?next=%2Fworkbench%2Flogs');
    expect(screen.getByText('See every request your key made.')).toBeTruthy();
  });

  it('loads as rows at the list height that say Loading once', () => {
    render(<BenchSkeleton rows={3} />);
    const status = screen.getByRole('status', { name: 'Loading' });
    expect(status.querySelectorAll('.bench-skel-r')).toHaveLength(3);
    expect(
      [...status.querySelectorAll('.bench-skel-r')].every(
        (r) => r.getAttribute('aria-hidden') === 'true',
      ),
    ).toBe(true);
  });
});

describe('the live indicator', () => {
  it('goes into the strip slot, says its state, and offers Resume only when stopped', () => {
    const slot = document.createElement('div');
    slot.setAttribute('data-bench-status', '');
    document.body.append(slot);
    const onResume = vi.fn();
    const { rerender } = render(<LiveIndicator state="listening" onResume={onResume} />);
    expect(slot.querySelector('[role="status"]')?.textContent).toBe('Listening');
    expect(slot.querySelector('.bench-live')?.getAttribute('data-state')).toBe('listening');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    rerender(<LiveIndicator state="paused" onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('is Offline when the network goes, whatever the tool thinks', () => {
    function Mark({ paused }: { paused: boolean }) {
      return <LiveIndicator inPlace state={useLiveState(paused)} />;
    }
    render(<Mark paused={false} />);
    expect(screen.getByRole('status').textContent).toBe('Listening');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status').textContent).toBe('Offline');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('status').textContent).toBe('Listening');
  });
});
