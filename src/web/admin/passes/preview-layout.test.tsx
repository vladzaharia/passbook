import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewLayout } from './preview-layout.tsx';

let width = 1200;
const listeners = new Set<() => void>();
const matches = (q: string) => {
  const max = /max-width:\s*([\d.]+)px/.exec(q);
  return max ? width <= Number(max[1]) : false;
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return matches(q);
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  listeners.clear();
});

const resize = (w: number) => {
  width = w;
  act(() => {
    for (const cb of listeners) cb();
  });
};

/** A sheet with a draft, like Pass colours. */
function Sheet() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      {open ? (
        <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : null}
    </>
  );
}

describe('PreviewLayout', () => {
  it('keeps lead and children mounted across every breakpoint', () => {
    width = 1200;
    render(
      <PreviewLayout title="Pass" stage={(s) => <p>{s}</p>} still={null} lead={<Sheet />}>
        <Sheet />
      </PreviewLayout>,
    );
    const [lead] = screen.getAllByRole('button', { name: 'Open sheet' });
    fireEvent.click(lead as HTMLElement);
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: '#123456' } });
    for (const w of [800, 500, 800, 1200]) {
      resize(w);
      expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('#123456');
    }
  });

  it('shows one stage per width', () => {
    width = 1200;
    render(
      <PreviewLayout title="Pass" stage={(s) => <p>stage {s}</p>} still={null}>
        <span>tabs</span>
      </PreviewLayout>,
    );
    expect(screen.getByText('stage column')).toBeTruthy();
    resize(800);
    expect(screen.getByText('stage card')).toBeTruthy();
    expect(screen.queryByText('stage column')).toBeNull();
    resize(500);
    expect(screen.getByRole('button', { name: 'Show pass' })).toBeTruthy();
  });
});
