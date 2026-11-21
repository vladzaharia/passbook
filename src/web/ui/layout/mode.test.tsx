import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { trackCurrentPath } from '../../lib/current-path.ts';
import { getMode, resetModeForTests, setTestOnlyOrgs } from '../../lib/mode.ts';
import { TooltipProvider } from '../tooltip.tsx';
import { ModeBand } from './mode-band.tsx';
import { ModePill } from './mode-pill.tsx';
import { ModeSwitch } from './mode-switch.tsx';
import { TestStrip } from './test-strip.tsx';

afterEach(() => {
  resetModeForTests();
  setTestOnlyOrgs([]);
  trackCurrentPath(() => '');
});

describe('a developer sandbox', () => {
  it('is always Test, in its own pages only', () => {
    setTestOnlyOrgs(['sbx']);
    trackCurrentPath(() => '/admin/o/sbx/passes');
    expect(getMode()).toBe('test');
    trackCurrentPath(() => '/admin/o/other/passes');
    expect(getMode()).toBe('live');
    trackCurrentPath(() => '/admin/platform/orgs');
    expect(getMode()).toBe('live');
  });
});

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
    await user.click(screen.getByRole('radio', { name: 'Test' }));
    expect(screen.getByRole('status')).toHaveClass('wl-test-strip');
    expect(screen.getByRole('status')).toHaveTextContent('New emails go to the Test inbox.');
  });
});

describe('ModeSwitch and ModeBand', () => {
  it('switches between Live and Test and shows the band while on', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <ModeSwitch />
        <ModeBand />
      </TooltipProvider>,
    );
    const live = screen.getByRole('radio', { name: 'Live' });
    const test = screen.getByRole('radio', { name: 'Test' });
    expect(live).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('status')).toBeNull();
    await user.click(test);
    expect(getMode()).toBe('test');
    expect(test).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Test mode');
    expect((await axe(container)).violations).toEqual([]);
    await user.click(live);
    expect(getMode()).toBe('live');
    expect(live).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
