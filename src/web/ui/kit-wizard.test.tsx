import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { Celebrate } from './celebrate.tsx';
import { Checklist } from './checklist.tsx';
import { OptionTile } from './option-tile.tsx';
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
        dirty
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

  it('moves forward and back, keeps values, focuses the step heading and guards Cancel', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    expect(onCancel).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('commits a tile on Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByLabelText('Org a').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Template step')).toBeInTheDocument();
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
