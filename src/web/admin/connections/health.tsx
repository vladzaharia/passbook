import type { z } from 'zod';
import type { ConnectionHealthSchema } from '@/shared/contracts/connections.ts';
import { StatusPill } from '../../ui/index.ts';

type Health = z.infer<typeof ConnectionHealthSchema>;

const MAP: Record<Health, { status: string; label: string }> = {
  healthy: { status: 'verified', label: 'Healthy' },
  degraded: { status: 'degraded', label: 'Degraded' },
  failing: { status: 'failing', label: 'Failing' },
  unknown: { status: 'not_configured', label: 'Unknown' },
  paused: { status: 'not_configured', label: 'Paused' },
  disabled: { status: 'not_configured', label: 'Disabled' },
};

export function HealthPill({ health }: { health: Health }) {
  const m = MAP[health];
  return <StatusPill status={m.status}>{m.label}</StatusPill>;
}
