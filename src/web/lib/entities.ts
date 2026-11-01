import {
  Activity,
  ArrowRightLeft,
  Braces,
  Building2,
  Cable,
  FileBadge,
  FlaskConical,
  History,
  Image,
  KeyRound,
  LayoutTemplate,
  type LucideIcon,
  Mail,
  Milestone,
  ScrollText,
  SearchX,
  Send,
  Smartphone,
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
  activity: { label: 'Event', plural: 'events', icon: Milestone, art: 'activity' },
  status: { label: 'Component', plural: 'components', icon: Activity, art: 'pulse' },
  workflowRun: { label: 'Workflow run', plural: 'workflow runs', icon: Workflow, art: 'runs' },
  device: { label: 'Device', plural: 'devices', icon: Smartphone, art: 'phone' },
  delivery: { label: 'Delivery', plural: 'deliveries', icon: Send, art: 'envelope' },
  image: { label: 'Image', plural: 'images', icon: Image, art: 'frames' },
  version: { label: 'Version', plural: 'versions', icon: History, art: 'layers' },
  mapping: { label: 'Mapping', plural: 'mappings', icon: ArrowRightLeft, art: 'mapping' },
  search: { label: 'Result', plural: 'results', icon: SearchX, art: 'lens' },
} as const satisfies Record<string, Entity>;

export type EntityKind = keyof typeof ENTITY;
export const ENTITY_KINDS = Object.keys(ENTITY) as EntityKind[];

/** Connector glyphs; unknown connectors use the connection icon. */
export const CONNECTOR_ICON: Record<string, LucideIcon> = {
  demo: FlaskConical,
  'http-json': Braces,
  webhook: Webhook,
};
export const connectorIcon = (id: string): LucideIcon => CONNECTOR_ICON[id] ?? Cable;

/** Delivery channel glyphs: push sends to devices, email mails the holder. */
export const DELIVERY_ICON: Record<string, LucideIcon> = { push: Send, email: Mail };
