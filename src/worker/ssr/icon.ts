import type { LucideIcon } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanIcon, type PlanIconProps } from '../../web/ui/plan-icon.tsx';
import { RowIcon, type RowIconProps } from '../../web/ui/row-icon.tsx';

/** A lucide icon as static markup, decorative, exactly as the SPA renders `<Icon aria-hidden />`. */
export const iconHtml = (Icon: LucideIcon): string =>
  renderToStaticMarkup(createElement(Icon, { 'aria-hidden': true }));

// SSR pages load no Tailwind, so the component's `size-5` does nothing; the svg carries its 20px size.
const sized = (html: string): string => html.replace('<svg ', '<svg width="20" height="20" ');

/** A plan icon as static markup: the SPA's PlanIcon, rendered at 20px. */
export const planIconHtml = (props: PlanIconProps): string =>
  sized(renderToStaticMarkup(createElement(PlanIcon, props)));

/** A feature-row icon as static markup: the SPA's RowIcon, rendered at 20px. */
export const rowIconHtml = (props: RowIconProps): string =>
  sized(renderToStaticMarkup(createElement(RowIcon, props)));
