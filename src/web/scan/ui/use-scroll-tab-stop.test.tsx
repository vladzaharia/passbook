import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useScrollTabStop } from './use-scroll-tab-stop.ts';

function Card({
  scroll,
  client,
  children,
}: {
  scroll: number;
  client: number;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useScrollTabStop(ref);
  return (
    <section ref={ref}>
      <div
        className="scan-result-body"
        data-testid="body"
        ref={(el) => {
          if (!el) return;
          Object.defineProperty(el, 'scrollHeight', { value: scroll, configurable: true });
          Object.defineProperty(el, 'clientHeight', { value: client, configurable: true });
        }}
      >
        {children}
      </div>
    </section>
  );
}

describe('useScrollTabStop', () => {
  it('makes an overflowing body with nothing to focus a tab stop', async () => {
    const { getByTestId } = render(
      <Card scroll={400} client={200}>
        text
      </Card>,
    );
    // The sizes are set by the ref callback after the first layout effect; a change re-checks.
    getByTestId('body').append(document.createTextNode(' more'));
    await waitFor(() => expect(getByTestId('body')).toHaveAttribute('tabindex', '0'));
  });

  it('leaves a body that fits, or has its own control, alone', async () => {
    const fits = render(
      <Card scroll={200} client={200}>
        text
      </Card>,
    );
    fits.getByTestId('body').append(document.createTextNode(' more'));
    await Promise.resolve();
    expect(fits.getByTestId('body')).not.toHaveAttribute('tabindex');
    fits.unmount();
    const own = render(
      <Card scroll={400} client={200}>
        <button type="button">Back</button>
      </Card>,
    );
    own.getByTestId('body').append(document.createTextNode(' more'));
    await Promise.resolve();
    expect(own.getByTestId('body')).not.toHaveAttribute('tabindex');
  });
});
