import { EventKindSchema } from '../../../shared/contracts/events.ts';
import { batch, chunk } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hashDevice, type PassEventInput, sanitizeEventData } from '../events/record.ts';
import type { Pass } from '../passes/repo.ts';
import { type PushFence, pushEventStmt } from './repo.ts';

export function pushEvent(
  pass: Pick<Pass, 'id' | 'orgId' | 'mode'>,
  kind: 'push.sent' | 'push.failed' | 'device.unregistered',
  data: Record<string, string | number>,
): PassEventInput {
  return { orgId: pass.orgId, passId: pass.id, mode: pass.mode, kind, data };
}

export async function recordPushEvents(
  ctx: ServiceContext,
  fence: PushFence,
  inputs: readonly PassEventInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  try {
    const rows = await Promise.all(
      inputs.map(async (input) => {
        const at = input.at ?? ctx.clock.now();
        return {
          id: ctx.ids.ordered(at),
          org_id: input.orgId,
          pass_id: input.passId,
          mode: input.mode,
          kind: EventKindSchema.parse(input.kind),
          device: input.device ? await hashDevice(input.device) : (input.deviceHash ?? null),
          actor_type: input.actor?.type ?? null,
          actor_id: input.actor?.id ?? null,
          data: JSON.stringify(
            sanitizeEventData({ ...input.data, appleGeneration: fence.credentialGeneration }),
          ),
          at,
        };
      }),
    );
    for (const part of chunk(rows, 50))
      await batch(
        ctx.env.DB,
        part.map((row) => pushEventStmt(ctx.env.DB, fence, row)),
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
