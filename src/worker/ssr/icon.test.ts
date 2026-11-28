import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PLAN_ICONS, ROW_ICONS } from '../../generated/plan-icons.ts';
import { PlanIcon } from '../../web/ui/plan-icon.tsx';
import { RowIcon } from '../../web/ui/row-icon.tsx';
import { planIconHtml, rowIconHtml } from './icon.ts';

/** React closes empty svg shapes with an end tag; the source self-closes them. */
const selfClosed = (html: string) =>
  html.replace(/<(\w+)([^>]*)><\/\1>/g, '<$1$2/>').replace(/ \/>/g, '/>');
const tight = (svg: string) => svg.replace(/ \/>/g, '/>');

describe('plan and row icon markup', () => {
  it('renders the same markup in the SPA and in SSR', () => {
    const plan = { id: 'business', label: 'Backstage', className: 'size-8' };
    expect(planIconHtml(plan)).toBe(renderToStaticMarkup(createElement(PlanIcon, plan)));
    const row = { icon: 'live-passes', mono: true };
    expect(rowIconHtml(row)).toBe(renderToStaticMarkup(createElement(RowIcon, row)));
    expect(planIconHtml({ id: 'trial' })).toMatchSnapshot();
    expect(rowIconHtml({ icon: 'live-passes' })).toMatchSnapshot();
  });

  it('renders every generated svg back to its source, with no innerHTML', () => {
    for (const [id, icon] of Object.entries(PLAN_ICONS))
      for (const mono of [false, true])
        expect(selfClosed(planIconHtml({ id, mono }))).toContain(
          tight(mono ? icon.mono : icon.svg),
        );
    for (const [icon, row] of Object.entries(ROW_ICONS))
      for (const mono of [false, true])
        expect(selfClosed(rowIconHtml({ icon, mono }))).toContain(tight(mono ? row.mono : row.svg));
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
