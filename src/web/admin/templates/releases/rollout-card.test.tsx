import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { json, stubFetch } from '../../../lib/test-utils.tsx';
import { RolloutCard } from './rollout-card.tsx';
import { VERSIONS } from './test-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

const rollout = (over: Partial<TemplateRollout> = {}): TemplateRollout => ({
  releaseVersion: 'version-2',
  total: 10,
  onRelease: 4,
  remaining: 6,
  failed: [],
  failedCount: 0,
  startedAt: 1,
  runId: null,
  running: false,
  ...over,
});

function mount(canTell = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RolloutCard
        templateId="t1"
        orgId="org-1"
        mode="live"
        versions={VERSIONS}
        canTell={canTell}
      />
    </QueryClientProvider>,
  );
}

describe('rollout card', () => {
  it('shows progress and Tell holders starts a notifying latest-design run', async () => {
    const posted: unknown[] = [];
    stubFetch({
      '/api/v1/templates/t1/rollout': () => json(rollout()),
      '/api/v1/broadcasts': (_url, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return json({}, 201);
      },
    });
    mount();
    expect(await screen.findByText('Updating passes to Version 2')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Passes on the release' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    expect(screen.getByText('Updating 6')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tell holders' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tell 6 holders' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      kind: 'change',
      notify: true,
      target: { templateIds: ['t1'] },
      patch: { $design: true },
    });
  });

  it('counts passes that cannot update and hides Tell holders without the capability', async () => {
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(rollout({ onRelease: 7, remaining: 3, failedCount: 3 })),
    });
    mount(false);
    expect(await screen.findByText("Can't update 3")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tell holders' })).toBeNull();
  });
});
