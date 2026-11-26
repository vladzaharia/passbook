import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { BenchFrame } from './frame.tsx';
import { BenchSlot } from './slots.tsx';
import { BENCH_TOOLS } from './switcher.tsx';

afterEach(cleanup);

describe('the bench frame', () => {
  it('gives every tool the same boxes: head, title row, toolbar and body', () => {
    for (const tool of BENCH_TOOLS) {
      const html = renderToStaticMarkup(
        <BenchFrame tool={tool}>
          <p>tool</p>
        </BenchFrame>,
      );
      document.body.innerHTML = html;
      const label = { console: 'Console', webhooks: 'Webhooks', logs: 'Logs', keys: 'Keys' }[tool];
      expect(document.querySelector('h1')?.textContent).toBe(label);
      const current = document.querySelectorAll('.bench-switch [aria-current="page"]');
      expect([...current].map((a) => a.textContent)).toEqual([label]);
      // One underline, named for the transition: on the current tab only.
      expect(document.querySelectorAll('.bench-ind')).toHaveLength(1);
      expect(document.querySelector('[data-island="bench-strip"]')?.getAttribute('data-tool')).toBe(
        tool,
      );
      for (const slot of ['status', 'count', 'action', 'toolbar'])
        expect(document.querySelector(`[data-bench-${slot}]`), slot).not.toBeNull();
      expect(document.querySelector('#tool')?.textContent).toBe('tool');
      expect(document.querySelector('#tool')?.getAttribute('tabindex')).toBe('-1');
    }
    // No style attributes: the CSP refuses them.
    expect(document.body.innerHTML).not.toContain('style=');
  });

  it('lets a tool draw into its slots, or in place without the frame', () => {
    render(
      <BenchSlot name="action">
        <button type="button">New key</button>
      </BenchSlot>,
    );
    expect(screen.getByRole('button', { name: 'New key' }).parentElement?.tagName).toBe('DIV');
    cleanup();
    document.body.innerHTML = renderToStaticMarkup(<BenchFrame tool="keys">{null}</BenchFrame>);
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <BenchSlot name="action">
        <button type="button">New key</button>
      </BenchSlot>,
      { container: host },
    );
    expect(document.querySelector('[data-bench-action] button')?.textContent).toBe('New key');
    expect(host.textContent).toBe('');
  });
});
