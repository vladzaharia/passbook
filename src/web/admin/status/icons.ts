import {
  Database,
  HardDrive,
  Layers,
  LogIn,
  type LucideIcon,
  Mail,
  Package,
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
