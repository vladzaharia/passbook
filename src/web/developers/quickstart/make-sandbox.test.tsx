import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureOperation, SANDBOX_CREATE } from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import { SandboxOperations } from '../ui/sandbox-operation.tsx';
import { MakeSandbox } from './make-sandbox.tsx';

vi.mock('../console/turnstile.ts', () => ({ verify: async () => 'tok' }));

beforeEach(() => resetOperationCache());
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers by "METHOD path"; a list answers one call each, the last one staying. */
function api(routes: Record<string, Response | Response[]>) {
  const seen: Record<string, number> = {};
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).replace('/api/v1', '')}`;
    const entry = routes[key];
    if (!entry) return new Response('{}', { status: 404 });
    const n = seen[key] ?? 0;
    seen[key] = n + 1;
    return (
      Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] as Response) : entry
    ).clone();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function Host({ onMade }: { onMade: (...a: unknown[]) => void }) {
  const [op, setOp] = useState<string | null>(null);
  return (
    <SandboxOperations csrf="c">
      <MakeSandbox
        csrf="c"
        siteKey="k"
        label="Create sandbox"
        onMade={onMade}
        op={op}
        onOp={setOp}
      />
    </SandboxOperations>
  );
}

const made = {
  ...fixtureOperation(SANDBOX_CREATE, { status: 'succeeded', id: 'op-c' }),
  result: {
    href: null,
    ids: { sandboxId: 's1', orgId: 'org-1', orgSlug: 'dev-1', templateId: 't1' },
  },
};
const adding = fixtureOperation(SANDBOX_CREATE, { status: 'running', at: 'template', id: 'op-c' });

describe('Create sandbox', () => {
  it('shows each step as it runs, then mints the key once and hands the sandbox to the page', async () => {
    const fetchMock = api({
      'POST /developer/sandbox': json(202, { operation: adding }),
      'GET /operations/op-c': [json(200, adding), json(200, made)],
      'POST /developer/sandbox/key': json(201, { key: { secret: 'pbp_test_once' } }),
    });
    const onMade = vi.fn();
    render(<Host onMade={onMade} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create sandbox' }));
    // The exact step, and every step, with the button gone.
    const panel = await screen.findByRole('region', { name: 'Create sandbox' });
    expect(screen.queryByRole('button', { name: 'Create sandbox' })).toBeNull();
    expect(
      (await within(panel).findAllByText('Adding the ticket template')).length,
    ).toBeGreaterThan(0);
    const items = within(within(panel).getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Create sandbox'),
      expect.stringContaining('Add ticket template'),
      expect.stringContaining('Release it in Test'),
      expect.stringContaining('Add capture endpoint'),
      expect.stringContaining('Add test scanner'),
    ]);
    await waitFor(
      () =>
        expect(onMade).toHaveBeenCalledWith(
          { id: 's1', orgId: 'org-1', orgSlug: 'dev-1', templateId: 't1' },
          'pbp_test_once',
        ),
      { timeout: 4000 },
    );
    const keyCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/sandbox/key'));
    expect(keyCalls).toHaveLength(1);
  });

  it('stops on the failed step with its sentence and Retry, and the retry runs it again', async () => {
    const failed = fixtureOperation(SANDBOX_CREATE, {
      status: 'failed',
      at: 'capture',
      id: 'op-c',
    });
    const fetchMock = api({
      'POST /developer/sandbox': json(202, { operation: adding }),
      'GET /operations/op-c': json(200, failed),
      'POST /operations/op-c/retry': json(202, {
        operation: { ...adding, attempt: 2, text: 'Adding the capture endpoint' },
      }),
    });
    render(<Host onMade={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create sandbox' }));
    expect(await screen.findByText('Could not finish your sandbox')).toBeTruthy();
    expect(screen.getByText('Webhooks are off on this plan. Retry.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/operations/op-c/retry')),
      ).toBe(true),
    );
  });

  it('hands over the sandbox without a key when it was shown already', async () => {
    api({
      'POST /developer/sandbox': json(202, { operation: made }),
      'GET /operations/op-c': json(200, made),
      'POST /developer/sandbox/key': json(409, {
        code: 'SANDBOX_KEY_SHOWN',
        detail: 'Shown once.',
      }),
    });
    const onMade = vi.fn();
    render(<Host onMade={onMade} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create sandbox' }));
    await waitFor(() =>
      expect(onMade).toHaveBeenCalledWith(
        { id: 's1', orgId: 'org-1', orgSlug: 'dev-1', templateId: 't1' },
        null,
      ),
    );
  });

  it('follows the one that is already running instead of showing an error', async () => {
    api({
      'POST /developer/sandbox': json(409, {
        code: 'OPERATION_RUNNING',
        detail: 'This is already running.',
        operationId: 'op-c',
      }),
      'GET /operations/op-c': json(200, adding),
    });
    render(<Host onMade={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Create sandbox' }));
    expect((await screen.findAllByText('Adding the ticket template')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
