import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../lib/test-utils.tsx';
import { ApiError } from '../../../lib/errors.ts';
import { DEFAULTS, encodeHash } from '../../playground/hash.ts';
import { takeIssueFocus } from '../issue-focus.ts';
import { HandoffSave, sampleWith } from './handoff-save.tsx';

const SHA = 'a'.repeat(40);
const replace = vi.fn();
const calls: { method: string; path: string; body?: unknown; key?: string }[] = [];
let failUse = false;
let taken = 0;

const api = {
  get: async (path: string) => {
    calls.push({ method: 'GET', path });
    if (path.endsWith('/versions/1'))
      return {
        version: '1',
        passJson: { storeCard: {} },
        manifest: { inputs: {}, sample: { holder: 'Sample', points: 10 } },
        assets: [{ name: 'logo.png', slot: 'logo', scale: 1, size: 3, sha1: SHA }],
      };
    return {
      id: 'baked:starter-store-card',
      name: 'Store card',
      blueprint: true,
      activeVersion: '1',
    };
  },
  post: async (
    path: string,
    _schema: unknown,
    body: unknown,
    opts?: { headers?: Record<string, string> },
  ) => {
    calls.push({ method: 'POST', path, body, key: opts?.headers?.['idempotency-key'] });
    if (path.endsWith('/use')) {
      if (taken > 0) {
        taken--;
        throw new ApiError({ status: 409, code: 'TEMPLATE_EXISTS', detail: 'Taken.' });
      }
      if (failUse) throw new ApiError({ status: 500, code: 'internal', detail: 'Broke.' });
      return {
        id: 'tpl-new',
        name: 'Store card',
        activeVersion: null,
        versions: [{ version: 'v1' }],
      };
    }
    return {};
  },
};

vi.mock('../../host/tool-host.tsx', () => ({
  useToolHost: () => ({ api, context: { orgId: 'sbx', kind: 'sandbox', name: 'Sandbox' } }),
}));
vi.mock('../../shell/tool-page.tsx', () => ({
  ToolPage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ history: { replace } }),
}));

const open = (code: string) =>
  history.replaceState(
    null,
    '',
    `/workbench/o/sbx/design${encodeHash({ template: 'baked:starter-store-card', edits: { holder: 'Ada', points: null }, ...DEFAULTS })}&s=${code}`,
  );

beforeEach(() => {
  calls.length = 0;
  failUse = false;
  taken = 0;
  replace.mockClear();
  sessionStorage.clear();
  // This tab pressed Save: its one-time code is kept, and the link carries the same one.
  sessionStorage.setItem('wb-anon-handoff', 'abc123');
  open('abc123');
});
afterEach(() => takeIssueFocus());

describe('saving a handed-off design in the sandbox', () => {
  it('makes the template from the blueprint with the edited sample, releases it to Test, and opens Design', async () => {
    render(<HandoffSave />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workbench/o/sbx/design/tpl-new'));
    const use = calls.find((c) => c.path.endsWith('/use'));
    expect(use?.path).toBe('/api/v1/templates/baked%3Astarter-store-card/use');
    expect(use?.body).toMatchObject({
      orgId: 'sbx',
      name: 'Store card',
      baseVersion: '1',
      version: {
        manifest: { sample: { holder: 'Ada' } },
        assets: [{ name: 'logo.png', sha1: SHA }],
      },
    });
    const release = calls.find((c) => c.path.endsWith('/templates/tpl-new/release'));
    expect(release?.body).toMatchObject({ orgId: 'sbx', version: 'v1', modes: ['test'] });
    expect(takeIssueFocus()).toBe(true);
    // One key per hand-off, and the code is spent.
    expect(use?.key).toBe('anon-abc123-1');
    expect(sessionStorage.getItem('wb-anon-handoff')).toBeNull();
  });

  it('asks before a code this tab already spent saves again', async () => {
    const first = render(<HandoffSave />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    first.unmount();
    calls.length = 0;
    replace.mockClear();
    render(<HandoffSave />);
    expect(await screen.findByText('Save this design to your sandbox?')).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/use'))).toBe(false);
  });

  it('asks about a link this tab did not start, shows its values and saves nothing until Save', async () => {
    open('forged');
    render(<HandoffSave />);
    expect(await screen.findByText('Save this design to your sandbox?')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save to my sandbox' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/workbench/o/sbx/design/tpl-new'));
    expect(calls.find((c) => c.path.endsWith('/use'))?.body).toMatchObject({
      version: { manifest: { sample: { holder: 'Ada' } } },
    });
  });

  it('says it did not save, and tries again from Retry', async () => {
    failUse = true;
    render(<HandoffSave />);
    expect(await screen.findByText('Could not save to your sandbox.')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    failUse = false;
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it('numbers the name when the blueprint was saved before', async () => {
    taken = 1;
    render(<HandoffSave />);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const uses = calls.filter((c) => c.path.endsWith('/use'));
    expect(uses.map((c) => (c.body as { name: string }).name)).toEqual([
      'Store card',
      'Store card 2',
    ]);
  });

  it('puts the edits over the sample and drops a field edited to null', () => {
    expect(sampleWith({ a: 1, b: 2 }, { a: 5, b: null, c: 'x' })).toEqual({ a: 5, c: 'x' });
  });
});
