import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { Celebrate } from './celebrate.tsx';
import { Checklist } from './checklist.tsx';
import { OptionTile } from './option-tile.tsx';
import { toast } from './toaster.tsx';
import { TwoPane } from './two-pane.tsx';
import { Wizard } from './wizard.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Celebrate and Checklist', () => {
  it('flies six sparks once, and none under reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { container, rerender } = render(<Celebrate when={false} />);
    expect(container.querySelectorAll('.wl-spark')).toHaveLength(0);
    rerender(<Celebrate when />);
    expect(container.querySelectorAll('.wl-spark')).toHaveLength(6);
    vi.unstubAllGlobals();
    const reduced = render(<Celebrate when />);
    expect(reduced.container.querySelectorAll('.wl-spark')).toHaveLength(0);
  });

  it('checks steps from props', () => {
    const steps = [
      { id: 'a', label: 'Assign a template', done: true },
      { id: 'b', label: 'Issue a pass', done: false, action: <a href="/x">Issue</a> },
    ];
    const { rerender } = render(<Checklist title="Get started" steps={steps} />);
    expect(screen.getByText('Assign a template')).toHaveTextContent('(done)');
    expect(screen.getByRole('link', { name: 'Issue' })).toBeInTheDocument();
    const marks = () => [...document.querySelectorAll('li > span[aria-hidden]')];
    // Done on load: the tick shows still, the mark does not pop.
    expect(marks()[0]?.querySelector('svg.wl-tick')).toBeNull();
    rerender(<Checklist title="Get started" steps={steps.map((s) => ({ ...s, done: true }))} />);
    expect(screen.queryByRole('link', { name: 'Issue' })).toBeNull();
    expect(screen.getByText('All steps done')).toBeInTheDocument();
    // Done from data after mount: the mark fills with a bounce and the tick draws.
    expect(marks()[1]).toHaveClass('wl-step-done');
    expect(marks()[1]?.querySelector('svg.wl-tick')).not.toBeNull();
    expect(marks()[0]).not.toHaveClass('wl-step-done');
  });
});

describe('Wizard and OptionTile', () => {
  function Harness({ onCancel = () => {} }: { onCancel?: () => void }) {
    const [step, setStep] = useState(0);
    const [org, setOrg] = useState('a');
    return (
      <Wizard
        steps={[
          { id: 'org', title: 'Organization' },
          { id: 'template', title: 'Template' },
        ]}
        current={step}
        onStep={setStep}
        onCancel={onCancel}
        onBack={step > 0 ? () => setStep(step - 1) : undefined}
        onNext={() => setStep(step + 1)}
        nextLabel={step === 1 ? 'Create' : 'Next'}
      >
        {step === 0 ? (
          <div role="radiogroup" aria-label="Organization">
            {['a', 'b'].map((v) => (
              <OptionTile
                key={v}
                name="org"
                value={v}
                label={`Org ${v}`}
                checked={org === v}
                onSelect={setOrg}
                onCommit={() => setStep(1)}
              />
            ))}
          </div>
        ) : (
          <p>Template step</p>
        )}
      </Wizard>
    );
  }

  it('moves forward and back, keeps values, focuses the step heading; Cancel only navigates', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    await user.click(screen.getByLabelText('Org b'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Template step')).toBeInTheDocument();
    // The finished step fills with a bounce and its tick draws.
    const done = screen.getByRole('button', { name: /Organization/ });
    expect(done.querySelector('.wl-step-done svg.wl-tick')).not.toBeNull();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Template' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: /Organization/ }));
    expect(screen.getByLabelText('Org b')).toBeChecked();
    // The page's route guard owns the unsaved-changes confirm; the wizard never asks a second time.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('commits a tile on Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByLabelText('Org a').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Template step')).toBeInTheDocument();
  });

  it('keeps a soft-disabled Next focusable: a press announces the hint and runs nothing', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <Wizard
        steps={[
          { id: 'a', title: 'Source' },
          { id: 'b', title: 'Check' },
        ]}
        current={0}
        onStep={() => {}}
        onCancel={() => {}}
        onNext={onNext}
        nextDisabled
        nextHint="Pick a source."
      >
        <p>Step</p>
      </Wizard>,
    );
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).not.toBeDisabled();
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveAccessibleDescription('Pick a source.');
    await user.click(next);
    expect(onNext).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Pick a source.'));
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  });

  it('says why a blocked Next is blocked on a phone, where the bar hides the hint', async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '');
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 639'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(
      <Wizard
        steps={[{ id: 'a', title: 'Source' }]}
        current={0}
        onStep={() => {}}
        onCancel={() => {}}
        onNext={() => {}}
        nextDisabled
        nextHint="Send a test first."
      >
        <p>Step</p>
      </Wizard>,
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(info).toHaveBeenCalledWith('Send a test first.');
    info.mockRestore();
  });

  it('toasts the hint once when onNext refuses on a phone, and never on a wide screen', async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '');
    const media = (phone: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: phone && query.includes('max-width: 639'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    const view = (
      <Wizard
        steps={[{ id: 'a', title: 'Source' }]}
        current={0}
        onStep={() => {}}
        onCancel={() => {}}
        onNext={() => false}
        nextHint="Fix the address."
      >
        <p>Step</p>
      </Wizard>
    );
    media(true);
    const phone = render(view);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith('Fix the address.');
    phone.unmount();
    info.mockClear();
    media(false);
    render(view);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Fix the address.'));
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('toasts a hint-only block from an external onBlocked, but not when a field is invalid', async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, 'info').mockImplementation(() => '');
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 639'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const view = (invalid: boolean) => (
      <Wizard
        steps={[{ id: 'a', title: 'Source' }]}
        current={0}
        onStep={() => {}}
        onCancel={() => {}}
        onBlocked={() => {}}
        nextDisabled
        nextHint="Pick a source."
      >
        <input aria-label="Name" aria-invalid={invalid || undefined} />
      </Wizard>
    );
    const first = render(view(true));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    expect(info).not.toHaveBeenCalled();
    first.unmount();
    render(view(false));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith('Pick a source.');
    info.mockRestore();
  });

  it('submits the form a formId names, and a blocked press does not', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const view = (disabled: boolean) => (
      <Wizard
        steps={[{ id: 'a', title: 'Source' }]}
        current={0}
        onStep={() => {}}
        onCancel={() => {}}
        formId="f"
        nextDisabled={disabled}
      >
        <form id="f" onSubmit={onSubmit} />
      </Wizard>
    );
    const { rerender } = render(view(true));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(view(false));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('shows the aside as a labelled stage from 1024 and hides it below', () => {
    const wizard = (
      <Wizard
        steps={[{ id: 'a', title: 'Template' }]}
        current={0}
        onStep={() => {}}
        aside={<p>Card</p>}
        asideLabel="Connector"
        onCancel={() => {}}
      >
        <p>Step</p>
      </Wizard>
    );
    const narrow = render(wizard);
    expect(screen.queryByRole('complementary')).toBeNull();
    // The step heading stays the focus target for screen readers; the stepper shows it.
    expect(screen.getByRole('heading', { name: 'Template' })).toHaveClass('sr-only');
    narrow.unmount();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = render(wizard);
    const stage = screen.getByRole('complementary', { name: 'Connector' });
    expect(stage).toHaveTextContent('Card');
    expect(container.firstElementChild).toHaveAttribute('data-staged');
  });

  it('places the aside beside the main column at 1024 when asked', () => {
    const { container } = render(
      <TwoPane asideFrom="lg" stickyAside aside={<p>Aside</p>}>
        Main
      </TwoPane>,
    );
    expect(container.firstElementChild?.className).toContain('lg:grid-cols-[minmax(0,1fr)_20rem]');
    expect(screen.getByText('Aside').parentElement?.className).toContain('lg:sticky');
  });
});
