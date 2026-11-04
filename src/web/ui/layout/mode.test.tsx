import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { getMode, resetModeForTests } from '../../lib/mode.ts';
import { TooltipProvider } from '../tooltip.tsx';
import { ModeBand } from './mode-band.tsx';
import { ModePill } from './mode-pill.tsx';
import { ModeSwitch } from './mode-switch.tsx';

afterEach(resetModeForTests);

describe('ModePill', () => {
  it('marks test and says nothing for live', () => {
    const { container, rerender } = render(<ModePill mode="live" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ModePill mode={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ModePill mode="test" />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('has a compact form with the sentence in its name', () => {
    render(
      <TooltipProvider>
        <ModePill mode="test" compact />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: /^Test\. Test mode/ })).toBeInTheDocument();
  });
});

describe('ModeSwitch and ModeBand', () => {
  it('turns Test mode on and off and shows the band while on', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <ModeSwitch />
        <ModeBand />
      </TooltipProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Test mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(toggle);
    expect(getMode()).toBe('test');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Test mode');
    expect((await axe(container)).violations).toEqual([]);
    await user.click(toggle);
    expect(getMode()).toBe('live');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
