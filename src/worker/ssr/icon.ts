import type { LucideIcon } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanIcon, type PlanIconProps } from '../../web/ui/plan-icon.tsx';
import { RowIcon, type RowIconProps } from '../../web/ui/row-icon.tsx';

/** A lucide icon as static markup, decorative, exactly as the SPA renders `<Icon aria-hidden />`. */
export const iconHtml = (Icon: LucideIcon): string =>
  renderToStaticMarkup(createElement(Icon, { 'aria-hidden': true }));

/** A plan icon as static markup: the SPA's PlanIcon, rendered. */
export const planIconHtml = (props: PlanIconProps): string =>
  renderToStaticMarkup(createElement(PlanIcon, props));

/** A feature-row icon as static markup: the SPA's RowIcon, rendered. */
export const rowIconHtml = (props: RowIconProps): string =>
  renderToStaticMarkup(createElement(RowIcon, props));
