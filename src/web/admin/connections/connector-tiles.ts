import {
  CalendarCheck,
  CreditCard,
  type LucideIcon,
  Repeat,
  Send,
  ShoppingBag,
  ShoppingCart,
  Ticket,
  Users,
  Webhook,
} from 'lucide-react';
import type { z } from 'zod';
import type {
  ConnectorCategory,
  ConnectorInfoSchema,
  RecipeId,
} from '@/shared/contracts/connections.ts';
import { connectorIcon } from '../../lib/entities.ts';

type Connector = z.infer<typeof ConnectorInfoSchema>;

/** Groups show above this many tiles; search shows above SEARCH_AT. */
export const GROUPS_AT = 8;
export const SEARCH_AT = 10;

/** The tiles' groups: the server's categories, and the one PassBook adds for sending out. */
export type TileCategory = ConnectorCategory | 'outbound';

/** The tile that sets up an endpoint PassBook posts to; it is not a stored connection. */
export const OUTBOUND = 'outbound';

export const GROUPS: readonly { id: TileCategory; label: string }[] = [
  { id: 'files', label: 'Files and sheets' },
  { id: 'apis', label: 'APIs' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'bookings', label: 'Bookings and tickets' },
  { id: 'outbound', label: 'Send from PassBook' },
  { id: 'try', label: 'Try it' },
];

export interface ConnectorTile {
  /** The recipe id for a sender, else the connector type. */
  key: string;
  type: string;
  /** Set on a sender tile: the webhook connector with this recipe fixed. */
  recipe?: RecipeId;
  label: string;
  line: string;
  category: TileCategory;
  icon: LucideIcon;
  /** Search terms beyond the label and group. */
  keywords: string;
}

/** Senders (recipes); the connectors' own glyphs come from `connectorIcon`. */
const ICON: Record<string, LucideIcon> = {
  'shopify-orders': ShoppingBag,
  'shopify-customers': Users,
  'stripe-subscriptions': Repeat,
  'stripe-payments': CreditCard,
  'woocommerce-orders': ShoppingCart,
  'calcom-bookings': CalendarCheck,
  'tickettailor-tickets': Ticket,
};

const KEYWORDS: Record<string, string> = {
  'file-upload': 'excel xlsx csv json ndjson spreadsheet',
  'csv-url': 'csv sheets google spreadsheet link',
  'http-json': 'api rest json http',
  'webhook-push': 'webhook push http',
  demo: 'sample fake test try',
};

/** The tile a connection's connector and sender pick: a sender's id, else the type. */
export const tileKey = (type: string | undefined, recipe: string | undefined): string =>
  (recipe && recipe !== 'custom' ? recipe : type) ?? '';

/** One tile per connector and per sender the plan allows, grouped and ordered. */
export function buildTiles(connectors: readonly Connector[]): ConnectorTile[] {
  const out: (ConnectorTile & { order: number })[] = [];
  for (const c of connectors) {
    if (c.entitled !== false) {
      out.push({
        key: c.type,
        type: c.type,
        label: c.displayName,
        line: c.description,
        category: c.category,
        order: c.order,
        icon: ICON[c.type] ?? connectorIcon(c.type),
        keywords: KEYWORDS[c.type] ?? '',
      });
    }
    c.recipes.forEach((r, i) => {
      if (r.entitled === false) return;
      out.push({
        key: r.id,
        type: c.type,
        recipe: r.id,
        label: r.label,
        line: 'Webhook',
        category: r.category,
        order: 100 + i,
        icon: ICON[r.id] ?? Webhook,
        keywords: `webhook ${r.id.replace(/-/g, ' ')}`,
      });
    });
  }
  out.push({
    key: OUTBOUND,
    type: OUTBOUND,
    label: 'Send to your server',
    line: 'Webhook out',
    category: 'outbound',
    order: 0,
    icon: Send,
    keywords: 'webhook endpoint outbound send events server notify',
  });
  const rank = (t: ConnectorTile) => GROUPS.findIndex((g) => g.id === t.category);
  return out.sort((a, b) => rank(a) - rank(b) || a.order - b.order).map(({ order: _, ...t }) => t);
}

/** Every word must match the label, group, fact line or keywords. */
export function matchTiles(tiles: readonly ConnectorTile[], query: string): ConnectorTile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tiles];
  return tiles.filter((t) => {
    const group = GROUPS.find((g) => g.id === t.category)?.label ?? '';
    const hay = `${t.label} ${group} ${t.line} ${t.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
