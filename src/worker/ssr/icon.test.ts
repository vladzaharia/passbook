import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanIcon } from '../../web/ui/plan-icon.tsx';
import { RowIcon } from '../../web/ui/row-icon.tsx';
import { planIconHtml, rowIconHtml } from './icon.ts';

describe('plan and row icon markup', () => {
  it('renders the same markup in the SPA and in SSR', () => {
    const plan = { id: 'business', label: 'Backstage', className: 'size-8' };
    expect(planIconHtml(plan)).toBe(renderToStaticMarkup(createElement(PlanIcon, plan)));
    const row = { icon: 'live-passes', mono: true };
    expect(rowIconHtml(row)).toBe(renderToStaticMarkup(createElement(RowIcon, row)));
    expect(planIconHtml({ id: 'trial' })).toMatchSnapshot();
    expect(rowIconHtml({ icon: 'live-passes' })).toMatchSnapshot();
  });

  it('is decorative unless labelled', () => {
    expect(planIconHtml({ id: 'trial' })).toContain('aria-hidden="true"');
    expect(planIconHtml({ id: 'trial', label: 'Stub' })).toContain('role="img" aria-label="Stub"');
    expect(rowIconHtml({ icon: 'live-passes' })).not.toContain('role=');
  });

  it('renders nothing for an unknown id', () => {
    expect(planIconHtml({ id: 'nope' })).toBe('');
    expect(rowIconHtml({ icon: 'nope' })).toBe('');
  });
});
