import { Bot, type LucideIcon, Monitor, Settings } from 'lucide-react';
import { humanize } from '@/web/lib/actions.ts';
import { ENTITY, type EntityKind } from '@/web/lib/entities.ts';
import type { AuditEntry } from './entry-drawer.tsx';

type Labeled = AuditEntry & { actorLabel?: string | null; targetLabel?: string | null };

interface RefDef {
  label: string;
  kind?: EntityKind;
  icon?: LucideIcon;
  /** The page for this record, when it has one. */
  to?: (id: string) => string;
}

const REFS: Record<string, RefDef> = {
  pass: { label: 'Pass', kind: 'pass', to: (id) => `/admin/passes/${id}` },
  template: { label: 'Template', kind: 'template', to: (id) => `/admin/templates/${id}` },
  template_import: { label: 'Template import', kind: 'template' },
  connection: { label: 'Connection', kind: 'connection', to: (id) => `/admin/connections/${id}` },
  user: { label: 'User', kind: 'user', to: (id) => `/admin/users/${id}` },
  holder: { label: 'Holder', kind: 'user' },
  org: { label: 'Organization', kind: 'org', to: (id) => `/admin/orgs/${id}` },
  identity: { label: 'Apple identity', kind: 'identity', to: (id) => `/admin/identities/${id}` },
  api_key: { label: 'API key', kind: 'apiKey', to: () => '/admin/api-keys' },
  device: { label: 'Device', kind: 'device' },
  session: { label: 'Session', icon: Monitor },
  settings: {
    label: 'Settings',
    icon: Settings,
    to: (id) => (id.startsWith('org:') ? `/admin/orgs/${id.slice(4)}` : '/admin/settings'),
  },
  system: { label: 'System', icon: Bot },
};

export interface Ref {
  kind?: EntityKind;
  icon: LucideIcon;
  /** The record's name; else its type and a short id. */
  name: string;
  to?: string;
}

function refOf(type: string, id: string | null, label: string | null | undefined): Ref {
  const def = REFS[type] ?? { label: humanize(type) };
  const icon = def.icon ?? (def.kind ? ENTITY[def.kind].icon : ENTITY.audit.icon);
  const name = label ?? (id ? `${def.label} ${id.slice(-6)}` : def.label);
  return { kind: def.kind, icon, name, to: id && def.to ? def.to(id) : undefined };
}

export const actorRef = (e: Labeled): Ref => refOf(e.actorType, e.actorId, e.actorLabel);

/** Undefined when the entry has no target (a sign-out, a cron run). */
export function targetRef(e: Labeled): Ref | undefined {
  return e.targetType ? refOf(e.targetType, e.targetId, e.targetLabel) : undefined;
}

export const targetTypeLabel = (type: string) => REFS[type]?.label ?? humanize(type);
