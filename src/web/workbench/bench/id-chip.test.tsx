import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { IdChip, jumpTargets, shortId } from './id-chip.tsx';
import { Trace, traceNodes } from './trace.tsx';
import { loadRequestEvents } from './trace-events.ts';

const REQ = '01938a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b';
const KEY = '01938a1b-0000-7000-8000-00000000a1f3';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the id chip', () => {
  it('shows the head and tail, and opens each kind where it lives (the bench URL grammar)', () => {
    expect(shortId(REQ)).toBe('01938a1b…4a5b');
    expect(shortId('evt_1')).toBe('evt_1');
    expect(jumpTargets('request', REQ).map((t) => [t.label, t.href])).toEqual([
      ['Logs', `/developers/logs?source=all#${REQ}`],
      ['Events it caused', `/developers/webhooks?request=${REQ}`],
    ]);
    expect(jumpTargets('key', KEY).map((t) => t.href)).toEqual([
      `/developers/keys#${KEY}`,
      `/developers/logs?key=${KEY}`,
    ]);
    expect(jumpTargets('pass', 'p 1').map((t) => t.href)).toEqual([
      '/developers/logs?path=p%201&source=all',
      '/developers/webhooks?pass=p%201',
    ]);
    expect(jumpTargets('event', 'e1')[0]?.href).toBe('/developers/webhooks#e1');
    expect(jumpTargets('op', 'passes.create')[0]?.href).toBe('/developers/console#passes.create');
    expect(jumpTargets('id', REQ)).toEqual([]);
  });

  it('copies on a press and says Copied for 1.5 s', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<IdChip id={REQ} kind="request" prefix="req" />);
    const face = screen.getByRole('button', { name: new RegExp(`, Copy request id ${REQ}$`) });
    expect(face.textContent).toBe('req 01938a1b…4a5b');
    await act(async () => fireEvent.click(face));
    expect(writeText).toHaveBeenCalledWith(REQ);
    expect(face.textContent).toBe('req Copied');
    expect(face.dataset.state).toBe('copied');
    act(() => vi.advanceTimersByTime(1600));
    expect(face.textContent).toBe('req 01938a1b…4a5b');
  });

  it('opens its menu from the keyboard and gives focus back on Escape', () => {
    render(<IdChip id={REQ} kind="request" />);
    const more = screen.getByRole('button', { name: 'Open request' });
    fireEvent.click(more);
    const menu = screen.getByRole('menu', { name: 'Open request' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Logs', 'Events it caused']);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Escape' });
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(menu.hidden).toBe(true);
  });

  it('resolves an unknown id when its menu opens, and says when it is not in the sandbox', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ kind: 'pass', href: '/developers/logs?path=x', label: 'Pass Ada' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    render(<IdChip id={REQ} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open object' })));
    expect(fetch).toHaveBeenCalledWith(`/api/v1/developer/resolve?id=${REQ}`, expect.anything());
    const found = screen.getByRole('menuitem', { name: 'Pass Ada' });
    expect(found.getAttribute('href')).toBe('/developers/logs?path=x');
    cleanup();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    render(<IdChip id={REQ} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open object' })));
    expect(
      screen.getByRole('menuitem', { name: 'Not in your sandbox' }).getAttribute('aria-disabled'),
    ).toBe('true');
    // A name that cannot be resolved has no menu at all, only Copy.
    cleanup();
    render(<IdChip id="not-an-id" />);
    expect(screen.queryByRole('button', { name: 'Open object' })).toBeNull();
  });
});

describe('the trace', () => {
  it('tells key → request → events, leaves out what it does not know, and draws nothing with no ids', () => {
    const nodes = traceNodes({
      key: { id: KEY, name: 'Default', prefix: 'pbp_test_PB8a' },
      request: { id: REQ, method: 'POST', path: '/passes', status: 201 },
      events: [{ id: 'evt-1', type: 'pass.issued' }],
    });
    const { container } = render(<Trace nodes={nodes} />);
    const nav = screen.getByRole('navigation', { name: 'Trace' });
    const chips = [...nav.querySelectorAll('.bench-id-v')].map((c) => c.textContent);
    expect(chips).toEqual(['Default pbp_test_PB8a…', 'POST /passes 201', 'pass.issued']);
    expect([...nav.querySelectorAll('.bench-trace-a')].map((a) => a.textContent)).toEqual([
      '→',
      '→',
    ]);
    cleanup();
    render(
      <Trace
        nodes={traceNodes({ request: { id: null, method: 'GET', path: '/x', status: 200 } })}
      />,
    );
    expect(screen.queryByRole('navigation', { name: 'Trace' })).toBeNull();
    expect(container.textContent).not.toContain('unknown');
  });

  it('finds the events one request caused across capture and URL endpoints, each once', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path.startsWith('/webhook-endpoints?'))
        return {
          items: [
            { id: 'cap', target: 'capture' },
            { id: 'url', target: 'url' },
          ],
        };
      if (path.includes('/cap/captures'))
        return { items: [{ eventId: 'e1', type: 'pass.issued', status: 200 }] };
      return {
        items: [
          { eventId: 'e1', type: 'pass.issued', lastStatus: 502 },
          { eventId: 'e2', type: 'pass.updated', lastStatus: null },
        ],
      };
    });
    const events = await loadRequestEvents('ray 1', get as never);
    expect(get).toHaveBeenCalledWith('/webhook-endpoints/cap/captures?requestId=ray%201');
    expect(get).toHaveBeenCalledWith('/webhook-endpoints/url/deliveries?requestId=ray%201');
    expect(events).toEqual([
      { id: 'e1', type: 'pass.issued', status: 200, endpointId: 'cap' },
      { id: 'e2', type: 'pass.updated', status: null, endpointId: 'url' },
    ]);
  });
});

describe('the chip is named by what it shows (WCAG 2.5.3)', () => {
  it('holds its visible text in its accessible name, which axe checks', async () => {
    const { container } = render(
      <>
        <IdChip id={REQ} kind="request" prefix="req" />
        <IdChip id="key-1" kind="key" prefix="key" text="Sandbox key" />
      </>,
    );
    const res = await axe(container, { runOnly: ['label-content-name-mismatch'] });
    expect(res.violations).toEqual([]);
    expect(screen.getByRole('button', { name: 'key Sandbox key, Copy key id key-1' })).toBeTruthy();
  });
});
