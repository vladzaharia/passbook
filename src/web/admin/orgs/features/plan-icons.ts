import {
  BadgeCheck,
  Building2,
  Gem,
  Hourglass,
  Layers,
  type LucideIcon,
  Sprout,
  SquareTerminal,
  Ticket,
  Infinity as Unlimited,
} from 'lucide-react';

const PLAN_ICON: Record<string, LucideIcon> = {
  trial: Hourglass,
  starter: Sprout,
  standard: BadgeCheck,
  business: Ticket,
  premium: Gem,
  enterprise: Building2,
  legacy: Unlimited,
  developer: SquareTerminal,
};

/** The plan's icon; a plan the web does not know gets the generic stack. */
export const planIcon = (id: string): LucideIcon => PLAN_ICON[id] ?? Layers;
