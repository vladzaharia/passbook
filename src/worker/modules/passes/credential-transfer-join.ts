import { derivedHmacKey } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { joinReadiness } from '../join/readiness.ts';
import { resolveTemplate } from './builder.ts';
import type { ConnectionTransferContent, TransferPass } from './repo-credential-transfer-read.ts';

const DIGITS = 10;
const encoder = new TextEncoder();

/**
 * Ten digits only the server can derive from the transfer: start and finish (which may run in another
 * request) rebuild the same value, and a retry never makes a second one.
 */
async function lookupValueFor(ctx: ServiceContext, transferId: string): Promise<string> {
  const key = await derivedHmacKey(ctx.env, 'join-attach-lookup-v1');
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(transferId) as BufferSource),
  );
  const n = new DataView(mac.buffer).getBigUint64(0) % 10n ** BigInt(DIGITS);
  return n.toString().padStart(DIGITS, '0');
}

/**
 * A joined card moving to its verified owner: its desk lookup value, which the join generated, is replaced
 * with the credentials, so the joiner's copy finds nothing. Only a value the join generated on the card's own
 * version and on this one is replaced: a shared default or a value the org assigned is left as it is, and the
 * transfer then asks for a reissue instead.
 */
export async function joinAttachContent(
  ctx: ServiceContext,
  transferId: string,
  source: TransferPass,
  version: string,
  content: ConnectionTransferContent,
  ownerUserId: string | null,
): Promise<{ content: ConnectionTransferContent; replaced: boolean }> {
  const kept = { content, replaced: false };
  if (!source.joined || source.pass.ownerUserId !== null || ownerUserId === null) return kept;
  const p = source.pass;
  const generated = async (v: string) => {
    const m = (await resolveTemplate(ctx, p.orgId, p.templateId, v)).manifest;
    return { input: m.scan?.lookup?.input, ok: joinReadiness(m, null).generated };
  };
  const head = await generated(version);
  const own = version === p.templateVersion ? head : await generated(p.templateVersion);
  const input = head.input;
  if (
    !input ||
    source.lookupInput !== input ||
    ![head, own].every((g) => g.input === input && g.ok.some((x) => x.key === input))
  )
    return kept;
  return {
    content: {
      ...content,
      personalization: {
        ...content.personalization,
        [input]: await lookupValueFor(ctx, transferId),
      },
    },
    replaced: true,
  };
}
