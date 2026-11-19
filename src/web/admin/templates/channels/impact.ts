import type { z } from 'zod';
import { isDigital } from '@/shared/channels.ts';
import type { ChannelImpactSchema } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';

type Impact = z.infer<typeof ChannelImpactSchema>;

/** What a save does, one sentence per effect: "Turns off Apple Wallet for 412 passes." */
export function impactLines(impact: readonly Impact[]): string[] {
  const lines: string[] = [];
  let digital = false;
  for (const i of impact) {
    if (i.passes > 0) {
      lines.push(
        (i.passes === 1 ? CHANNEL_COPY.turnsOffOne : CHANNEL_COPY.turnsOff)
          .replace('{channel}', CHANNEL_LABEL[i.channel])
          .replace('{n}', String(i.passes)),
      );
      if (isDigital(i.channel)) digital = true;
    }
    if (i.clearedOverrides > 0)
      lines.push(
        i.clearedOverrides === 1
          ? CHANNEL_COPY.clearsOne
          : CHANNEL_COPY.clears.replace('{n}', String(i.clearedOverrides)),
      );
  }
  if (digital) lines.push(CHANNEL_COPY.copiesKeep);
  return lines.length > 0 ? lines : [CHANNEL_COPY.noChange];
}
