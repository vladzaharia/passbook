import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { IDLE_MS, listen, POLL_MS } from './live.ts';
import { entry, open, page, rowsOf } from './test-support.ts';

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const host = () => document.body.appendChild(document.createElement('div'));

describe('the listener', () => {
  it('asks every few seconds while the page is in view, and pauses while it is hidden', async () => {
    const tick = vi.fn(async () => {});
    const live = listen(tick, host());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(live.el.textContent).toContain(LOGS_COPY.live.on);
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(live.el.dataset.state).toBe('paused');
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(live.el.dataset.state).toBe('on');
    live.stop();
  });

  it('stops after ten quiet minutes, and Resume listens again', async () => {
    const tick = vi.fn(async () => {});
    const live = listen(tick, host());
    await vi.advanceTimersByTimeAsync(IDLE_MS + POLL_MS * 2);
    const before = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(tick.mock.calls.length).toBe(before);
    expect(live.el.textContent).toContain(LOGS_COPY.live.paused);
    const resume = live.el.querySelector('button');
    expect(resume?.hidden).toBe(false);
    resume?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick.mock.calls.length).toBe(before + 1);
    expect(resume?.hidden).toBe(true);
    live.stop();
  });

  it('a call heard starts the quiet clock over', async () => {
    const tick = vi.fn(async () => {});
    const live = listen(tick, host());
    await vi.advanceTimersByTimeAsync(IDLE_MS - POLL_MS);
    live.heard();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(live.el.dataset.state).toBe('on');
    live.stop();
  });

  it('ends once its page is gone', async () => {
    const tick = vi.fn(async () => {});
    const el = host();
    listen(tick, el);
    el.remove();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe('the log while it listens', () => {
  it('slides newer calls in at the top, asks from the newest, and says how many', async () => {
    const { el, live, calls } = await open([
      page([entry(2)]),
      page([entry(0, { id: 'log-new' }), entry(1)]),
    ]);
    expect(live.querySelector('.logs-live')?.textContent).toContain(LOGS_COPY.live.on);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls.at(-1)).toContain('after=log-2');
    const rows = rowsOf(el);
    expect([...rows].map((r) => r.dataset.id)).toEqual(['log-new', 'log-1', 'log-2']);
    expect(rows[0]?.classList.contains('logs-new')).toBe(true);
    expect(rows[2]?.classList.contains('logs-new')).toBe(false);
    expect(el.querySelector('[aria-live]')?.textContent).toBe(LOGS_COPY.live.fresh(2));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls.at(-1)).toContain('after=log-new');
  });

  it('replaces the first-call card with the first call', async () => {
    const { el } = await open([page([]), page([entry(1)])]);
    await vi.waitFor(() => expect(el.querySelector('.logs-first')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(rowsOf(el)).toHaveLength(1);
    expect(el.querySelector('.logs-first')).toBeNull();
    expect(el.querySelector<HTMLElement>('.logs-bar')?.hidden).toBe(false);
  });
});

describe('reduced motion', () => {
  const css = ['logs.css', 'logs-list.css', 'logs-detail.css']
    .map((f) => readFileSync(join(process.cwd(), 'src/web/developers/logs', f), 'utf8'))
    .join('\n');
  /** The CSS outside every `prefers-reduced-motion: no-preference` block. */
  const outside = css.replace(
    /@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
    '',
  );

  it('moves rows, the opened detail and the dot only when motion is welcome', () => {
    for (const name of ['logs-in', 'logs-blink', 'logs-rail'])
      expect(outside, name).not.toMatch(new RegExp(`animation:[^;]*\\b${name}\\b`));
    expect(css).toMatch(/\.logs-new \{\s*animation: logs-in/);
  });

  it('keeps the new-row highlight, a fade with no movement', () => {
    expect(outside).toMatch(/\.logs-new > \.logs-sum::after \{\s*animation: logs-glow/);
    expect(css).toMatch(/@keyframes logs-glow \{\s*from \{\s*opacity: 0\.8;\s*\}\s*\}/);
  });
});
