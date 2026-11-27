import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../lib/test-utils.tsx';
import { ApiError } from '../../../lib/errors.ts';
import { DEFAULTS, encodeHash } from '../../playground/hash.ts';
import { takeIssueFocus } from '../issue-focus.ts';
import { HandoffSave, sampleWith } from './handoff-save.tsx';

const SHA = 'a'.repeat(40);
const replace = vi.fn();
const calls: { method: string; path: string; body?: unknown }[] = [];
let failUse = false;

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
  post: async (path: string, _schema: unknown, body: unknown) => {
    calls.push({ method: 'POST', path, body });
    if (path.endsWith('/use')) {
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

beforeEach(() => {
  calls.length = 0;
  failUse = false;
  replace.mockClear();
  sessionStorage.clear();
  const hash = `${encodeHash({ template: 'baked:starter-store-card', edits: { holder: 'Ada', points: null }, ...DEFAULTS })}&s=1`;
  history.replaceState(null, '', `/workbench/o/sbx/design${hash}`);
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

  it('puts the edits over the sample and drops a field edited to null', () => {
    expect(sampleWith({ a: 1, b: 2 }, { a: 5, b: null, c: 'x' })).toEqual({ a: 5, c: 'x' });
  });
});
