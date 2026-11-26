import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewStep } from './review-step.tsx';
import type { ChangeWizard } from './use-change-wizard.ts';

const data = {
  targeted: 1240,
  unchanged: 0,
  blocked: [],
  notified: 0,
  silent: 1240,
  overBudget: 0,
  estimated: true,
  samples: [
    {
      passId: 'p1',
      title: 'Seed 1',
      changes: [],
    },
  ],
};

const wizard = (isFetching: boolean) =>
  ({
    preview: { data, isFetching, isError: false },
    notify: false,
    tellable: false,
    kind: 'fields',
    startMs: null,
    rows: [{}],
    setStep: () => undefined,
  }) as unknown as ChangeWizard;

describe('the review step while it re-checks', () => {
  it('keeps the last counts on screen and shows a loading rail', async () => {
    const { container } = render(
      <ReviewStep
        w={wizard(true)}
        which="1,240 passes"
        picked={undefined}
        onEdit={() => undefined}
      />,
    );
    expect(screen.getByText('Will change')).toBeInTheDocument();
    expect(screen.getAllByText('Seed 1')).not.toHaveLength(0);
    await waitFor(() => expect(container.querySelector('.wl-rail')).not.toBeNull());
  });

  it('shows no rail when nothing is being fetched', () => {
    const { container } = render(
      <ReviewStep
        w={wizard(false)}
        which="1,240 passes"
        picked={undefined}
        onEdit={() => undefined}
      />,
    );
    expect(container.querySelector('.wl-rail')).toBeNull();
  });
});
