import type { LucideIcon } from 'lucide-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** A lucide icon as static markup, decorative, exactly as the SPA renders `<Icon aria-hidden />`. */
export const iconHtml = (Icon: LucideIcon): string =>
  renderToStaticMarkup(createElement(Icon, { 'aria-hidden': true }));
