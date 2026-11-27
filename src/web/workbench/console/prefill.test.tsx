import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpConsole } from './app/console.tsx';
import { resetBudget } from './budget.ts';
import { tryClient } from './client.ts';
import { applyPrefill, parseHash } from './prefill.ts';
import { initialDraft } from './request.ts';
import { fakeNetwork, json, passesCreate } from './test-support.ts';
import { resetToken } from './token.ts';
import type { RunOp } from './types.ts';

const list: RunOp = {
  ...passesCreate,
  id: 'passes.getPasses',
  method: 'get',
  path: '/api/v1/passes',
  idempotent: false,
  params: [
    {
      name: 'externalId',
      where: 'query',
      required: false,
      schema: { type: 'string' },
      description: '',
    },
  ],
  body: null,
  example: undefined,
};

beforeEach(() => {
  resetToken();
  resetBudget();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a guide link', () => {
  it('lays the body over the example and the sandbox template over its example id', () => {
    const { prefill } = parseHash(
      `#passes.postPasses?body=${encodeURIComponent(JSON.stringify({ templateId: 'example', input: { name: 'Grace' } }))}`,
    );
    const draft = applyPrefill(
      initialDraft(passesCreate, 'tpl_mine'),
      passesCreate,
      prefill,
      'tpl_mine',
    );
    expect(JSON.parse(draft.body)).toEqual({ templateId: 'tpl_mine', input: { name: 'Grace' } });
  });

  it('keeps only the query parameters the operation declares, and drops a body it cannot take', () => {
    const { prefill } = parseHash('#passes.getPasses?q.externalId=order-1&q.evil=1&body=%7B%7D');
    const draft = applyPrefill(initialDraft(list, null), list, prefill, null);
    expect(draft.query).toEqual({ externalId: 'order-1' });
    expect(draft.body).toBe('');
  });

  it('ignores a body that is not JSON', () => {
    expect(parseHash('#passes.postPasses?body=%7Bnot').prefill).toEqual({ query: {} });
  });

  it('opens the console with the request filled in, and sends exactly it', async () => {
    const net = fakeNetwork(() => json({ id: 'p1' }, { status: 201 }));
    const prefill = { body: { templateId: 'tpl_1', input: { name: 'Edsger' } }, query: {} };
    render(
      <OpConsole
        op={passesCreate}
        mode="console"
        origin="https://passbook.mobile"
        client={tryClient('c')}
        templateId={null}
        codes={new Set()}
        prefill={prefill}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByText('201 Created');
    const sent = net.calls.find((c) => c.path === '/api/v1/passes');
    expect(JSON.parse(sent?.body ?? '{}')).toEqual(prefill.body);
  });
});
