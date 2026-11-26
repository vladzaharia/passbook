import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Inspector } from './inspector.tsx';
import { BenchSplit } from './split.tsx';

beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** `width`: which of the frame's breakpoints match; reduced motion so a close is immediate. */
const media = (width: number) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') ? width >= 1180 : q.includes('720') ? width >= 720 : q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

function Request({ onPrev = vi.fn(), onNext = vi.fn(), onClose = vi.fn() }) {
  const [tab, setTab] = useState('request');
  return (
    <BenchSplit
      bare
      open
      onClose={onClose}
      label="Request"
      main={<p>rows</p>}
      pane={
        <Inspector
          title="GET /passes?limit=abc"
          label="Request GET /passes"
          itemKey="r2"
          status={<span>422</span>}
          tabs={[
            { id: 'request', label: 'Request' },
            { id: 'response', label: 'Response' },
          ]}
          tab={tab}
          onTab={setTab}
          onPrev={onPrev}
          onNext={onNext}
          trace={<p>trace</p>}
        >
          <p>{tab} body</p>
          <input aria-label="Field" />
        </Inspector>
      }
    />
  );
}

describe('the inspector', () => {
  it('beside the list from 1180 px: header, tabs, body, Trace; no Close or Prev / Next', () => {
    media(1440);
    render(<Request />);
    const pane = screen.getByRole('complementary', { name: 'Request' });
    expect(within(pane).getByRole('heading', { level: 2 }).textContent).toBe('GET /passes?limit=abc');
    expect(within(pane).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(pane.querySelector('.bench-insp')?.getAttribute('data-shape')).toBe('side');
    expect(within(pane).getByText('trace')).toBeTruthy();
  });

  it('tabs rove with the arrows, Home and End, and each controls the one labelled panel', () => {
    media(1440);
    render(<Request />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getByText('response body')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Response' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(screen.getByText('request body')).toBeTruthy();
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });

  it('in a drawer: Previous, Next and Close in its own header; [ and ] step except while typing', () => {
    media(834);
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<Request onPrev={onPrev} onNext={onNext} onClose={onClose} />);
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.querySelector('.bench-sheet-h')).toBeNull();
    expect(dialog.querySelector('.bench-insp')?.getAttribute('data-shape')).toBe('drawer');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    fireEvent.keyDown(within(dialog).getByRole('tabpanel'), { key: '[' });
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'Field' }), { key: ']' });
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('below 720 px it is a bottom sheet with its grab handle', () => {
    media(390);
    const { container } = render(<Request />);
    expect(container.querySelector('.bench-insp')?.getAttribute('data-shape')).toBe('sheet');
    expect(container.querySelector('dialog > .bench-grab[data-bare]')).toBeTruthy();
  });
});
