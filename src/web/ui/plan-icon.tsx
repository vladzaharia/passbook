import { createElement, type ReactElement, type ReactNode } from 'react';
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
export function svgElement(markup: string): ReactElement {
  const hit = parsed.get(markup);
  if (hit) return hit;
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
  parsed.set(markup, root);
  return root;
}

/** A plan's ticket icon. */
export function PlanIcon({ id, label, mono, className }: PlanIconProps) {
  const icon = PLAN_ICONS[id];
  if (!icon) return null;
  return (
    <span
      data-plan-icon={id}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn('inline-flex size-5 shrink-0 [&>svg]:size-full', className)}
    >
      {svgElement(mono ? icon.mono : icon.svg)}
    </span>
  );
}
