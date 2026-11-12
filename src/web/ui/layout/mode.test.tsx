import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { getMode, resetModeForTests } from '../../lib/mode.ts';
import { TooltipProvider } from '../tooltip.tsx';
import { ModeBand } from './mode-band.tsx';
import { ModePill } from './mode-pill.tsx';
import { ModeSwitch } from './mode-switch.tsx';
import { TestStrip } from './test-strip.tsx';

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

describe('TestStrip', () => {
  it('is the one markup for the console band and the SSR ribbon, in flow', () => {
    const html = renderToStaticMarkup(<TestStrip more="· More.">Test pass.</TestStrip>);
    expect(html).toContain('class="wl-test-strip"');
    expect(html).toContain('Test pass.');
    expect(html).toContain('data-more="sm"');
    const css = readFileSync(join(process.cwd(), 'src/web/ui/layout/test-strip.css'), 'utf8');
    expect(css).not.toMatch(/position:\s*(absolute|fixed)/);
  });

  it('shows the band while on, naming new emails', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ModeSwitch />
        <ModeBand />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole('switch', { name: 'Test mode' }));
    expect(screen.getByRole('status')).toHaveClass('wl-test-strip');
    expect(screen.getByRole('status')).toHaveTextContent('New emails go to the Test inbox.');
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
    // The words on screen are the control's name.
    expect(screen.getByText('Test mode')).toHaveAttribute(
      'id',
      toggle.getAttribute('aria-labelledby'),
    );
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(toggle);
    expect(getMode()).toBe('test');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Test mode');
    expect((await axe(container)).violations).toEqual([]);
    await user.click(toggle);
    expect(getMode()).toBe('live');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
