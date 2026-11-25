import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { StepList, StepMarker } from '../step-marker.tsx';
import type { WizardModel, WizardStepState } from './use-wizard.ts';
import { WizardStepper } from './wizard-stepper.tsx';

function model(states: WizardStepState[], over: Partial<WizardModel> = {}): WizardModel {
  const steps = states.map((state, i) => ({
    id: `s${i}`,
    title: `Step ${i + 1}`,
    summary: state === 'done' ? `chose ${i + 1}` : undefined,
    skip: state === 'skipped',
    state,
  }));
  return {
    steps,
    mode: 'create',
    index: Math.max(0, states.indexOf('current')),
    go: vi.fn(),
    ...over,
  } as unknown as WizardModel;
}

describe('WizardStepper', () => {
  it('names done steps by title, describes them by what was chosen, and jumps on press', async () => {
    const user = userEvent.setup();
    const wizard = model(['done', 'current', 'todo']);
    render(<WizardStepper wizard={wizard} />);
    const done = screen.getByRole('button', { name: 'Step 1' });
    expect(done).toHaveAccessibleDescription('chose 1');
    await user.click(done);
    expect(wizard.go).toHaveBeenCalledWith('s0');
    const current = screen
      .getByText('Step 2', { selector: 'span.text-sm' })
      .closest('[aria-current]');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: 'Step 3' })).toBeNull();
  });

  it('marks an invalid step with words and a button, and a skipped one with a dash and no button', () => {
    render(<WizardStepper wizard={model(['done', 'invalid', 'skipped', 'current'])} />);
    expect(screen.getByRole('button', { name: 'Step 2' })).toHaveAccessibleDescription(
      'needs attention',
    );
    expect(screen.queryByRole('button', { name: 'Step 3' })).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'Steps' }).querySelector('ol');
    expect(rail?.querySelectorAll('[data-state="skipped"]')[0]).toHaveTextContent('–');
    expect(rail?.querySelectorAll('[data-state="invalid"]')[0]).toHaveTextContent('!');
    expect(within(rail as HTMLElement).getByText('skipped')).toHaveClass('sr-only');
    expect(screen.getByText(/Step 3/, { selector: 'span.line-through' })).toBeInTheDocument();
  });

  it('counts only steps that are not skipped in the compact header', () => {
    render(<WizardStepper wizard={model(['done', 'skipped', 'current', 'todo'])} />);
    expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
  });

  it('lets every other step through in edit mode', async () => {
    const wizard = model(['current', 'todo', 'todo'], { mode: 'edit' });
    render(<WizardStepper wizard={wizard} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Step 3' }));
    expect(wizard.go).toHaveBeenCalledWith('s2');
  });
});

describe('WizardStepper pop', () => {
  it('pops only a step that became done after mounting, and not one done from the start', () => {
    const { container, rerender } = render(
      <WizardStepper wizard={model(['done', 'current', 'todo'])} />,
    );
    expect(container.querySelector('.wl-step-done')).toBeNull();
    rerender(<WizardStepper wizard={model(['done', 'done', 'current'])} />);
    expect(container.querySelectorAll('.wl-step-done')).toHaveLength(1);
    rerender(<WizardStepper wizard={model(['done', 'done', 'current'])} />);
    expect(container.querySelectorAll('.wl-step-done')).toHaveLength(1);
  });

  it('starts an edit rail with every step done and nothing popping', () => {
    const { container } = render(
      <WizardStepper wizard={model(['current', 'done', 'done'], { mode: 'edit' })} />,
    );
    expect(container.querySelector('.wl-step-done')).toBeNull();
  });

  it('shows hover on the title through the button group, not a descendant selector', () => {
    render(<WizardStepper wizard={model(['done', 'current'])} />);
    const button = screen.getByRole('button', { name: 'Step 1' });
    expect(button.className).toContain('group');
    expect(button.innerHTML).toContain('group-hover:text-fg-strong');
  });
});

describe('StepMarker and StepList', () => {
  it('says in words what a marker cannot', () => {
    render(
      <StepList
        label="Setup"
        items={[
          { id: 'a', label: 'One', state: 'invalid' },
          { id: 'b', label: 'Two', state: 'working' },
          { id: 'c', label: 'Three', state: 'current' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Setup' });
    expect(within(list).getByText('One')).toHaveTextContent('(needs attention)');
    expect(within(list).getByText('Two')).toHaveTextContent('(in progress)');
    expect(within(list).getByText('Three')).toHaveTextContent('(current)');
  });

  it('sizes the spinner with the marker', () => {
    const { container } = render(<StepMarker state="working" n={1} size="lg" />);
    expect(container.querySelector('svg')).toHaveClass('size-4');
  });

  it('pops and draws only when fresh', () => {
    const { container, rerender } = render(<StepMarker state="done" n={1} />);
    expect(container.querySelector('.wl-step-done')).toBeNull();
    rerender(<StepMarker state="done" n={1} fresh />);
    expect(container.querySelector('.wl-step-done svg.wl-tick')).not.toBeNull();
  });

  it('lists progress with state in words', () => {
    render(
      <StepList
        label="Setup"
        items={[
          { id: 'a', label: 'Sent', state: 'done' },
          { id: 'b', label: 'On screen', state: 'working' },
          { id: 'c', label: 'Tag read', state: 'todo' },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Setup' });
    expect(within(list).getByText('Sent')).toHaveTextContent('(done)');
    expect(list.querySelector('[aria-current="step"]')).toHaveTextContent('On screen');
  });
});
