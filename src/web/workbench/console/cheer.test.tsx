import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpConsole } from './app/console.tsx';
import { resetBudget } from './budget.ts';
import { firstIssue, momentOf } from './cheer.ts';
import { tryClient } from './client.ts';
import type { Outcome } from './send.ts';
import { fakeNetwork, json, passesCreate, passesVoid } from './test-support.ts';
import { resetToken } from './token.ts';

const props = {
  origin: 'https://x',
  client: tryClient('c'),
  templateId: null,
  codes: new Set<string>(),
} as const;
const run = () => userEvent.click(screen.getByRole('button', { name: 'Run' }));
const outcome = (status: number, body: unknown = {}): Outcome => ({
  status,
  statusText: '',
  ms: 1,
  requestId: null,
  replayed: false,
  headers: [],
  text: '',
  truncated: false,
  json: body as Outcome['json'],
  key: null,
});
const scene = (c: HTMLElement) =>
  c.querySelector('.cr-cheer .wl-buddy')?.getAttribute('data-scene');

beforeEach(() => {
  resetToken();
  resetBudget();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the buddy at the response', () => {
  it('cheers a 2xx create with its line, and is sorry for a 4xx or 5xx with the first issue', () => {
    expect(momentOf(passesCreate, outcome(201))).toEqual({ kind: 'cheer', caption: 'Pass issued' });
    expect(momentOf(passesCreate, outcome(200))?.kind).toBe('cheer');
    expect(
      momentOf({ ...passesCreate, sdk: { call: 'pb.templates.create' } }, outcome(201)),
    ).toEqual({ kind: 'cheer', caption: 'Created' });
    expect(momentOf(passesVoid, outcome(200))).toBeNull();
    expect(momentOf({ ...passesCreate, method: 'get' }, outcome(200))).toBeNull();
    expect(
      momentOf(
        passesCreate,
        outcome(422, { issues: [{ path: 'templateId', message: 'is required' }] }),
      ),
    ).toEqual({ kind: 'sorry', caption: 'templateId is required' });
    expect(momentOf(passesCreate, outcome(500))).toEqual({ kind: 'sorry', caption: null });
  });

  it('reads the issue as a string, or falls back to the detail', () => {
    expect(firstIssue({ issues: ['bad'] })).toBe('bad');
    expect(firstIssue({ detail: 'Nope.' })).toBe('Nope.');
    expect(firstIssue(null)).toBeNull();
  });

  it('cheers on every create, not once', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const { container } = render(<OpConsole op={passesCreate} mode="console" {...props} />);
    await run();
    await screen.findByText('201 Created');
    await vi.waitFor(() => expect(scene(container)).toBe('cheer'));
    expect(screen.getByText('Pass issued')).toBeInTheDocument();
    await run();
    await vi.waitFor(() => expect(scene(container)).toBe('cheer'));
  });

  it('is sorry for a 4xx until the next good run', async () => {
    let reply = json({ issues: [{ path: 'input', message: 'is required' }] }, { status: 422 });
    fakeNetwork(() => reply);
    const { container } = render(<OpConsole op={passesCreate} mode="console" {...props} />);
    await run();
    await screen.findByText('422 Unprocessable');
    await vi.waitFor(() => expect(scene(container)).toBe('sorry'));
    expect(screen.getByText('input is required')).toBeInTheDocument();
    reply = json({ id: 'p1' }, { status: 201 });
    await run();
    await screen.findByText('201 Created');
    await vi.waitFor(() => expect(scene(container)).toBe('cheer'));
  });

  it('does not act on a reference page', async () => {
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const op = render(<OpConsole op={passesCreate} mode="op" {...props} />);
    await run();
    await screen.findByText('201 Created');
    expect(op.container.querySelector('.cr-cheer')).toBeNull();
  });

  it('is still under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const { container } = render(<OpConsole op={passesCreate} mode="console" {...props} />);
    await run();
    await vi.waitFor(() =>
      expect(container.querySelector('.cr-cheer')?.getAttribute('data-still')).toBe('true'),
    );
  });
});
