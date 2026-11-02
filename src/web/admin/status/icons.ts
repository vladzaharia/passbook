import {
  Database,
  Gauge,
  HardDrive,
  Layers,
  LogIn,
  type LucideIcon,
  Mail,
  Package,
  ShieldCheck,
  Siren,
  Timer,
} from 'lucide-react';
import { ENTITY } from '@/web/lib/entities.ts';
import type { Component } from './groups.ts';

/** Entities keep their registry glyph; infrastructure gets its own. */
export const COMPONENT_ICON: Record<Component['kind'], LucideIcon> = {
  database: Database,
  storage: HardDrive,
  queue: Layers,
  cron: Timer,
  build: Package,
  email: Mail,
  identity: ENTITY.identity.icon,
  oidc: LogIn,
  connection: ENTITY.connection.icon,
  workflow: ENTITY.workflowRun.icon,
};

/** Components that share a kind but are different things get their own glyph. */
export const COMPONENT_ID_ICON: Record<string, LucideIcon> = {
  breakglass: Siren,
  turnstile: ShieldCheck,
  ratelimits: Gauge,
};

export const componentIcon = (c: Pick<Component, 'id' | 'kind'>): LucideIcon =>
  COMPONENT_ID_ICON[c.id] ?? COMPONENT_ICON[c.kind];
