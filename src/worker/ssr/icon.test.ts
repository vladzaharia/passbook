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
const unsized = (html: string) => html.replace('<svg width="20" height="20" ', '<svg ');

describe('plan and row icon markup', () => {
  it('renders the SPA markup, with an explicit size because SSR pages have no Tailwind', () => {
    const plan = { id: 'business', label: 'Backstage', className: 'size-8' };
    expect(unsized(planIconHtml(plan))).toBe(renderToStaticMarkup(createElement(PlanIcon, plan)));
    const row = { icon: 'live-passes', mono: true };
    expect(unsized(rowIconHtml(row))).toBe(renderToStaticMarkup(createElement(RowIcon, row)));
    expect(planIconHtml(plan)).toContain('<svg width="20" height="20" ');
    expect(rowIconHtml(row)).toContain('<svg width="20" height="20" ');
    expect(planIconHtml({ id: 'trial' })).toMatchSnapshot();
    expect(rowIconHtml({ icon: 'live-passes' })).toMatchSnapshot();
  });

  it('renders the same markup as the SPA component for every plan and row icon', () => {
    for (const id of Object.keys(PLAN_ICONS))
      for (const mono of [false, true]) {
        const props = { id, mono };
        expect(unsized(planIconHtml(props))).toBe(
          renderToStaticMarkup(createElement(PlanIcon, props)),
        );
      }
    for (const icon of Object.keys(ROW_ICONS))
      for (const mono of [false, true]) {
        const props = { icon, mono };
        expect(unsized(rowIconHtml(props))).toBe(
          renderToStaticMarkup(createElement(RowIcon, props)),
        );
      }
  });

  it('renders every generated svg back to its source, with no innerHTML', () => {
    const plain = (html: string) => selfClosed(unsized(html)).replace(/~\w+/g, '');
    for (const [id, icon] of Object.entries(PLAN_ICONS))
      for (const mono of [false, true])
        expect(plain(planIconHtml({ id, mono }))).toContain(tight(mono ? icon.mono : icon.svg));
    for (const [icon, row] of Object.entries(ROW_ICONS))
      for (const mono of [false, true])
        expect(plain(rowIconHtml({ icon, mono }))).toContain(tight(mono ? row.mono : row.svg));
  });

  it('gives two copies of a masked icon on one page different mask ids', () => {
    const page = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(PlanIcon, { id: 'trial', mono: true }),
        createElement(PlanIcon, { id: 'trial', mono: true }),
      ),
    );
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(page).toContain(`url(#${id})`);
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
