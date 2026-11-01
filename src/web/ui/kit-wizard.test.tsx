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
    rerender(<Checklist title="Get started" steps={steps.map((s) => ({ ...s, done: true }))} />);
    expect(screen.queryByRole('link', { name: 'Issue' })).toBeNull();
    expect(screen.getByText('All steps done')).toBeInTheDocument();
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
