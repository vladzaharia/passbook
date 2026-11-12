import type { Check } from '../../platform/authority-checks.ts';
import type { PassDeliveryBinding } from './binding.ts';
import type { DeliveryActor } from './delivery-actor.ts';
import { parseContext } from './issuance-context.ts';
import {
  connectionCheck,
  issuanceLineageCheck,
  passLineageChecks,
  queuedDeliveryCheck,
} from './repo-delivery-checks.ts';
import { getIntent } from './repo-issuance-recovery.ts';

/** What the irreversible step of a queued email must still hold: its actor and the lineage checks. */
export interface EmailOutput {
  actor: DeliveryActor;
  /** The second authority of a two-authority request, checked live as well. */
  also?: DeliveryActor | undefined;
  /** The mail has no `intent.actor`: queued before the cutover. Delivered on the legacy path. */
  legacy?: true;
  checks: Check[];
}

/** The lineage checks for a pass named by an email binding (not the version or content snapshot). */
export function bindingChecks(binding: PassDeliveryBinding): Check[] {
  return passLineageChecks({ ...binding, id: binding.passId });
}

/**
 * Authority of a queued pass email, rechecked inside the grant that marks the provider call or
 * captures the message (Rule 4). The actor is the one captured when the mail was queued, never the
 * session that queued it. Null when an issuance email has lost its durable row.
 */
export async function passEmailOutput(
  db: D1Database,
  outboxId: string,
  intent: {
    issuanceId?: string | undefined;
    actor?: DeliveryActor | undefined;
    also?: DeliveryActor | undefined;
  },
  binding: PassDeliveryBinding,
): Promise<EmailOutput | null> {
  const checks = bindingChecks(binding);
  const actor: DeliveryActor = intent.actor ?? { kind: 'system' };
  const base = { actor, also: intent.also, ...(intent.actor ? {} : { legacy: true as const }) };
  if (intent.issuanceId === undefined) return { ...base, checks };
  const row = await getIntent(db, intent.issuanceId);
  const context = row ? parseContext(row) : null;
  if (!row || !context || row.pass_id !== binding.passId) return null;
  checks.push(issuanceLineageCheck(row.pass_id), queuedDeliveryCheck(row.pass_id, outboxId));
  if (context.connection)
    checks.push(
      connectionCheck({
        connectionId: context.connection.connectionId,
        generation: context.connection.generation,
        mode: context.connectionMode,
      }),
    );
  return { ...base, checks };
}
