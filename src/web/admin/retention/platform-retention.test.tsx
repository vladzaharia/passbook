import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';

describe('platform retention page', () => {
  it('lists the receipts of platform-scope deletions', async () => {
    await renderApp('/admin/platform/retention', {
      session: 'admin',
      handlers: {
        '/api/v1/platform/retention/receipts': () =>
          json({
            items: [
              {
                id: 'r1',
                cls: 'photos',
                kind: 'sweep',
                ranAt: 1_700_000_000_000,
                cutoffAt: 1,
                policyDays: 30,
                deleted: 7,
                anonymised: 0,
                verified: true,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Retention', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/7 deleted, 30-day window/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download receipt, Photos/ })).toBeInTheDocument();
  });
});
