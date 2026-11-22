import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import { json, stubFetch } from '../../../lib/test-utils.tsx';
import { RolloutCard } from './rollout-card.tsx';

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
  tell: { path: 'change', text: null, until: 2 },
  ...over,
});

const TEMPLATE = {
  id: 't1',
  versions: [
    { version: 'version-1', createdAt: 1 },
    { version: 'version-2', createdAt: 2 },
  ],
} as unknown as ComponentProps<typeof RolloutCard>['template'];
const scope = (canTell: boolean) =>
  ({
    orgId: 'org-1',
    membership: { capabilities: canTell ? ['messages:manage', 'passes:operate'] : [] },
  }) as unknown as ComponentProps<typeof RolloutCard>['scope'];

function mount(canTell = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RolloutCard template={TEMPLATE} scope={scope(canTell)} />
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
    expect(await screen.findByText('Updating passes to v2')).toBeInTheDocument();
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

  it('after passes moved, Tell holders sends the message text', async () => {
    const posted: unknown[] = [];
    stubFetch({
      '/api/v1/templates/t1/rollout': () =>
        json(
          rollout({
            onRelease: 10,
            remaining: 0,
            tell: { path: 'message', text: 'Gym has a new design.', until: 2 },
          }),
        ),
      '/api/v1/broadcasts': (_url, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return json({}, 201);
      },
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Tell holders' }));
    const text = screen.getByRole('textbox', { name: /Message/ });
    expect(text).toHaveValue('Gym has a new design.');
    await userEvent.click(screen.getByRole('button', { name: 'Tell 10 holders' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      kind: 'message',
      notify: true,
      patch: { message: 'Gym has a new design.' },
      target: { templateIds: ['t1'] },
    });
  });

  it('hides Tell holders once the offer has ended', async () => {
    stubFetch({ '/api/v1/templates/t1/rollout': () => json(rollout({ tell: null })) });
    mount();
    expect(await screen.findByText('Updating passes to v2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tell holders' })).toBeNull();
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
