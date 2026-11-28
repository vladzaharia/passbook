import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateView } from './state-view.tsx';

const view = () => screen.getByTestId('state-view');

describe('StateView', () => {
  it.each([
    ['inline', false],
    ['panel', true],
    ['stage', true],
    ['hosted', true],
  ] as const)('%s: carries its size and seats a buddy only when not inline', (size, buddy) => {
    const { container } = render(<StateView size={size} art="passes" title="No passes yet" />);
    expect(view()).toHaveAttribute('data-size', size);
    expect(view()).toHaveAttribute('data-state', 'empty');
    expect(container.querySelector('[data-buddy]') !== null).toBe(buddy);
  });

  it('says a title, at most one line, one action and a link', () => {
    render(
      <StateView
        title="No passes yet"
        line="Create one."
        action={<button type="button">Create pass</button>}
        secondary={<a href="/docs">Read more</a>}
      />,
    );
    expect(view().querySelectorAll('p')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Create pass' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read more' })).toBeInTheDocument();
  });

  it('is slate for failed and forbidden, neutral otherwise', () => {
    const tone = (state: 'failed' | 'no-access' | 'empty' | 'not-found') => {
      const { unmount } = render(<StateView state={state} title="x" />);
      const value = view().dataset.tone;
      unmount();
      return value;
    };
    expect(tone('failed')).toBe('system');
    expect(tone('no-access')).toBe('slate');
    expect(tone('empty')).toBe('neutral');
    expect(tone('not-found')).toBe('neutral');
  });

  it('reads a failure out as an alert, with the sad buddy', () => {
    const { container } = render(<StateView state="failed" alert title="Passes did not load." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Passes did not load.');
    expect(container.querySelector('[data-buddy] [data-part="w"]')).toHaveAttribute(
      'data-mood',
      'sad',
    );
  });

  it('makes the title the page h1 when asked', () => {
    render(<StateView heading state="not-found" art="torn" title="Pass not found" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Pass not found' })).toBeInTheDocument();
  });

  it('shows loading as a status band with no art', () => {
    const { container } = render(<StateView state="loading" title="Checking…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
    expect(container.querySelector('[data-buddy], svg')).toBeNull();
  });

  it('loads the art on demand when given a loader', async () => {
    render(
      <StateView
        title="Lazy"
        artLoader={async () => ({ default: () => <i data-testid="late-art" /> })}
      />,
    );
    expect(await screen.findByTestId('late-art')).toBeInTheDocument();
  });
});
