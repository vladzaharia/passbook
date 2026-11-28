import { createElement, type ReactElement, type ReactNode, useId, useMemo } from 'react';
import { PLAN_ICONS } from '@/generated/plan-icons.ts';
import { cn } from '@/web/lib/cn.ts';

export interface PlanIconProps {
  /** Preset id: trial, starter, standard, business, premium, enterprise, legacy. */
  id: string;
  /** Decorative unless labelled. */
  label?: string;
  /** One colour (currentColor) instead of the ticket's own. */
  mono?: boolean;
  className?: string;
}

const parsed = new Map<string, ReactElement>();

/**
 * The generated svg (tools/build-plan-icons.ts: svg, g, path, circle, rect, defs and mask, double-quoted
 * attributes, no text) as React elements. The page enforces Trusted Types, so it is never set as innerHTML.
 */
function svgElement(markup: string, instance?: string): ReactElement {
  const own = instance !== undefined && markup.includes(' id="');
  const hit = own ? undefined : parsed.get(markup);
  if (hit) return hit;
  if (own) markup = withUniqueIds(markup, instance);
  const stack: { tag: string; props: Record<string, string>; kids: ReactNode[] }[] = [];
  let root: ReactElement | undefined;
  for (const [, close, tag = '', attrs = '', self] of markup.matchAll(
    /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g,
  )) {
    if (close) {
      const done = stack.pop();
      if (!done) throw new Error('unbalanced svg');
      const el = createElement(done.tag, done.props, ...done.kids);
      const parent = stack.at(-1);
      if (parent) parent.kids.push(el);
      else root = el;
      continue;
    }
    const props: Record<string, string> = {};
    for (const [, name = '', value = ''] of attrs.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g))
      props[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    if (!self) {
      stack.push({ tag, props, kids: [] });
      continue;
    }
    const el = createElement(tag, props);
    const parent = stack.at(-1);
    if (parent) parent.kids.push(el);
    else root = el;
  }
  if (!root) throw new Error('empty svg');
  if (!own) parsed.set(markup, root);
  return root;
}

/** Two copies of an icon on one page must not share mask ids: `~<instance>` goes on every id and reference. */
const withUniqueIds = (markup: string, instance: string): string =>
  markup
    .replace(/ id="([^"]+)"/g, (_, id: string) => ` id="${id}~${instance}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${id}~${instance})`);

/** The icon's svg with ids made unique for this instance. */
export function useSvg(markup: string | undefined): ReactElement | null {
  const instance = useId().replace(/\W/g, '');
  return useMemo(() => (markup ? svgElement(markup, instance) : null), [markup, instance]);
}

/** A plan's ticket icon. */
export function PlanIcon({ id, label, mono, className }: PlanIconProps) {
  const icon = PLAN_ICONS[id];
  const svg = useSvg(mono ? icon?.mono : icon?.svg);
  if (!icon) return null;
  return (
    <span
      data-plan-icon={id}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('inline-flex size-5 shrink-0 [&>svg]:size-full', className)}
    >
      {svg}
    </span>
  );
}
