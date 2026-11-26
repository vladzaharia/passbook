import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { useWizard } from './use-wizard.ts';
import { WizardDialog } from './wizard-dialog.tsx';
import { WizardStepper } from './wizard-stepper.tsx';
import type { WizardModel } from './wizard-types.ts';

type Id = 'one' | 'review';
const STEPS = [
  { id: 'one', title: 'Basics', heading: 'Name it' },
  { id: 'review', title: 'Review', heading: 'Check it' },
] as const;

function Harness() {
  const [done, setDone] = useState(false);
  const w = useWizard<Id>({
    open: true,
    steps: STEPS,
    errors: {},
    fieldStep: {},
    onFinish: () => setDone(true),
  });
  return (
    <WizardDialog
      open
      onOpenChange={() => undefined}
      title="New thing"
      wizard={w}
      finishLabel="Create thing"
      result={done ? { title: 'Copy it', body: <p>The secret</p> } : undefined}
    >
      <p>{w.id}</p>
    </WizardDialog>
  );
}

const motion = (reduce: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion: reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

async function finish() {
  const user = userEvent.setup();
  render(<Harness />);
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  await user.click(await within(dialog).findByRole('button', { name: 'Create thing' }));
}

afterEach(() => vi.restoreAllMocks());

describe('finish beat', () => {
  it('ticks the last marker before the result takes the dialog, which seats a happy buddy', async () => {
    motion(false);
    await finish();
    const held = screen.getByRole('dialog', { name: 'New thing' });
    expect(within(held).getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(held.querySelector('.wl-buddy')).toBeNull();
    const reveal = await screen.findByRole('dialog', { name: /Copy it/ });
    expect(reveal.querySelectorAll('.wl-buddy')).toHaveLength(1);
    expect(reveal.querySelector('.wl-buddy')?.closest('[data-dialog-body]')).toBeNull();
  });

  it('skips the beat under reduced motion', async () => {
    motion(true);
    await finish();
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Copy it/ })).toBeInTheDocument(),
    );
  });
});

describe('WizardStepper finished', () => {
  it('shows the current step done', () => {
    const wizard = {
      steps: [
        { id: 'a', title: 'A', state: 'done' },
        { id: 'b', title: 'B', state: 'current' },
      ],
      mode: 'create',
      index: 1,
      go: () => undefined,
    } as unknown as WizardModel;
    const { rerender } = render(<WizardStepper wizard={wizard} />);
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
    rerender(<WizardStepper wizard={wizard} finished />);
    expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
  });
});
