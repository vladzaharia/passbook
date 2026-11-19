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
 * with the credentials, so the joiner's copy finds nothing. A lookup input the join did not generate (a
 * default, or a value the org assigned) is left as it is: the transfer then asks for a reissue instead.
 */
export async function joinAttachContent(
  ctx: ServiceContext,
  transferId: string,
  source: TransferPass,
  version: string,
  content: ConnectionTransferContent,
  ownerUserId: string | null,
): Promise<ConnectionTransferContent> {
  if (!source.joined || source.pass.ownerUserId !== null || ownerUserId === null) return content;
  const p = source.pass;
  const manifest = (await resolveTemplate(ctx, p.orgId, p.templateId, version)).manifest;
  const input = manifest.scan?.lookup?.input;
  if (!input || !joinReadiness(manifest, null).generated.some((g) => g.key === input))
    return content;
  return {
    ...content,
    personalization: { ...content.personalization, [input]: await lookupValueFor(ctx, transferId) },
  };
}
