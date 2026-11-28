import { Layers, type LucideIcon, SquareTerminal } from 'lucide-react';
import { createElement, type FC } from 'react';
import { PLAN_ICONS } from '@/generated/plan-icons.ts';
import { PlanIcon } from '@/web/ui/plan-icon.tsx';
import '@/generated/plan-icons.css';

type IconComponent = FC<{ className?: string; 'aria-hidden'?: boolean }>;

const PLAN_COMPONENTS: Record<string, IconComponent> = Object.fromEntries(
  Object.keys(PLAN_ICONS).map((id) => [
    id,
    (props) => createElement(PlanIcon, { id, className: props.className }),
  ]),
);

/** The plan's icon; a plan the web does not know gets the generic stack, the developer sandbox a terminal. */
export const planIcon = (id: string): IconComponent | LucideIcon =>
  PLAN_COMPONENTS[id] ?? (id === 'developer' ? SquareTerminal : Layers);
