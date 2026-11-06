import {
  Activity,
  ArrowRightLeft,
  Braces,
  Building2,
  Cable,
  CalendarCheck,
  FileBadge,
  History,
  IdCard,
  Image,
  KeyRound,
  LayoutTemplate,
  type LucideIcon,
  Mail,
  Megaphone,
  Milestone,
  Package,
  ScanLine,
  ScrollText,
  SearchX,
  Send,
  Smartphone,
  Sparkles,
  Ticket,
  User,
  Webhook,
  Workflow,
} from 'lucide-react';
import type { ArtName } from '../ui/art/index.ts';

export interface Entity {
  label: string;
  /** Lower case unless a proper noun: "No passes match". */
  plural: string;
  icon: LucideIcon;
  art: ArtName;
}

/** One glyph and one illustration per entity (docs/design/ui-consistency.md "Entity identity"). */
export const ENTITY = {
  pass: { label: 'Pass', plural: 'passes', icon: Ticket, art: 'passes' },
  template: { label: 'Template', plural: 'templates', icon: LayoutTemplate, art: 'template' },
  connection: { label: 'Connection', plural: 'connections', icon: Cable, art: 'plugs' },
  user: { label: 'User', plural: 'users', icon: User, art: 'people' },
  org: { label: 'Organization', plural: 'organizations', icon: Building2, art: 'building' },
  identity: {
    label: 'Apple identity',
    plural: 'Apple identities',
    icon: FileBadge,
    art: 'certificate',
  },
  apiKey: { label: 'API key', plural: 'API keys', icon: KeyRound, art: 'key' },
  audit: { label: 'Audit entry', plural: 'audit entries', icon: ScrollText, art: 'log' },
  /** A pass's ledger row. "Event" is the real-world occasion (`event` below). */
  activity: { label: 'Entry', plural: 'entries', icon: Milestone, art: 'activity' },
  status: { label: 'Component', plural: 'components', icon: Activity, art: 'pulse' },
  workflowRun: { label: 'Workflow run', plural: 'workflow runs', icon: Workflow, art: 'runs' },
  device: { label: 'Device', plural: 'devices', icon: Smartphone, art: 'phone' },
  broadcast: { label: 'Message', plural: 'messages', icon: Megaphone, art: 'broadcast' },
  bundle: { label: 'Bundle', plural: 'bundles', icon: Package, art: 'bundle' },
  delivery: { label: 'Delivery', plural: 'deliveries', icon: Send, art: 'envelope' },
  image: { label: 'Image', plural: 'images', icon: Image, art: 'frames' },
  version: { label: 'Version', plural: 'versions', icon: History, art: 'layers' },
  mapping: { label: 'Mapping', plural: 'mappings', icon: ArrowRightLeft, art: 'mapping' },
  // Scanning. Art is borrowed until BU.1 adds scanner, stub and badge (entities.test PENDING_ART).
  scanner: { label: 'Scanner', plural: 'scanners', icon: ScanLine, art: 'phone' },
  event: { label: 'Event', plural: 'events', icon: CalendarCheck, art: 'passes' },
  staff: { label: 'Staff', plural: 'staff', icon: IdCard, art: 'people' },
  search: { label: 'Result', plural: 'results', icon: SearchX, art: 'lens' },
} as const satisfies Record<string, Entity>;

export type EntityKind = keyof typeof ENTITY;
export const ENTITY_KINDS = Object.keys(ENTITY) as EntityKind[];

/** Connector glyphs; unknown connectors use the connection icon. */
export const CONNECTOR_ICON: Record<string, LucideIcon> = {
  demo: Sparkles,
  'http-json': Braces,
  'webhook-push': Webhook,
};
export const connectorIcon = (id: string): LucideIcon => CONNECTOR_ICON[id] ?? Cable;

/** Delivery channel glyphs: push sends to devices, email mails the holder. */
export const DELIVERY_ICON: Record<string, LucideIcon> = { push: Send, email: Mail };
