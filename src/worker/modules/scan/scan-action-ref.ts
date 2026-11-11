import { derivedHmacKey } from '../../platform/crypto.ts';
import { toHex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';

const encoder = new TextEncoder();

/** Bind a private action ID to its tenant, mode and template without disclosing it. */
export async function scanActionIdRef(
  env: object,
  input: { orgId: string; mode: 'live' | 'test'; templateId: string; actionId: string },
): Promise<string> {
  const { orgId, mode, templateId, actionId } = input;
  if (
    typeof orgId !== 'string' ||
    !orgId ||
    (mode !== 'live' && mode !== 'test') ||
    typeof templateId !== 'string' ||
    !templateId ||
    typeof actionId !== 'string' ||
    !actionId
  )
    throw new Error('Invalid scan action reference input');
  const bytes = encoder.encode(canonicalJson([1, orgId, mode, templateId, actionId]));
  const key = await derivedHmacKey(env, 'scan-action-reference.v1');
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)));
}
