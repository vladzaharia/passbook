import { EventKindSchema } from '../../../shared/contracts/events.ts';
import { batch, chunk } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hashDevice, type PassEventInput, sanitizeEventData } from '../events/record.ts';
import { type AppleEventCredential, appleEventStmt } from './repo-events.ts';

export type AppleEvent = PassEventInput & AppleEventCredential;

/** Preserve best-effort event recording without letting delayed Wallet work cross a transfer. */
export async function recordAppleEvents(
  ctx: ServiceContext,
  inputs: readonly AppleEvent[],
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    const entries = await Promise.all(
      inputs.map(async (input) => {
        const at = input.at ?? ctx.clock.now();
        return {
          input,
          row: {
            id: ctx.ids.ordered(at),
            org_id: input.orgId,
            pass_id: input.passId,
            mode: input.mode,
            kind: EventKindSchema.parse(input.kind),
            device: input.device ? await hashDevice(input.device) : (input.deviceHash ?? null),
            actor_type: input.actor?.type ?? null,
            actor_id: input.actor?.id ?? null,
            data: JSON.stringify(
              sanitizeEventData({ ...input.data, appleGeneration: input.credentialGeneration }),
            ),
            at,
          },
        };
      }),
    );
    for (const part of chunk(entries, 50))
      await batch(
        ctx.env.DB,
        part.map(({ row, input }) => appleEventStmt(ctx.env.DB, row, input)),
      );
  } catch (error) {
    ctx.log.error('events.record_failed', {
      code: 'EVENT_RECORD_FAILED',
      count: inputs.length,
      kind: inputs[0]?.kind,
      passId: inputs[0]?.passId,
      error,
    });
  }
}
