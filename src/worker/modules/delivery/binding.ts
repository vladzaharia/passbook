import { z } from 'zod';
import { sha256Hex } from '../../platform/ids.ts';
import type { Pass } from '../passes/repo.ts';
import type { ReleaseRow } from '../templates/repo-releases.ts';
import { DeliveryActorSchema } from './delivery-actor.ts';

/** Only a digest of the bearer link is stored in the outbox. */
export const PassDeliveryBindingSchema = z.object({
  passId: z.string(),
  orgId: z.string(),
  mode: z.enum(['live', 'test']),
  testDataQuarantined: z.boolean(),
  holderEmail: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  version: z.number().int().positive(),
  identityId: z.string(),
  credentialGeneration: z.number().int().positive(),
  lifecycleGeneration: z.number().int().nonnegative(),
  templateId: z.string(),
  templateVersion: z.string(),
  releaseId: z.string().nullable(),
  webServiceUrl: z.string(),
  linkGeneration: z.number().int().positive(),
  objectKey: z.string(),
  downloadTokenHash: z.string().length(64),
  status: z.enum(['active', 'voided']),
  removedAt: z.number().nullable(),
});
export type PassDeliveryBinding = z.infer<typeof PassDeliveryBindingSchema>;

/** The snapshot used when the caller chose and authorized the recipient. */
export type ExpectedPassDelivery = Pick<
  Pass,
  | 'id'
  | 'orgId'
  | 'mode'
  | 'testDataQuarantined'
  | 'holderEmail'
  | 'ownerUserId'
  | 'version'
  | 'identityId'
  | 'credentialGeneration'
  | 'lifecycleGeneration'
  | 'templateId'
  | 'templateVersion'
  | 'releaseId'
  | 'webServiceUrl'
  | 'linkGeneration'
  | 'objectKey'
  | 'downloadToken'
  | 'status'
  | 'removedAt'
>;

/** Authority captured by a connection run before it fetched the source record. */
export interface ConnectionEmailAuthority {
  orgId: string;
  connectionId: string;
  externalRef: string | null;
  generation: number;
}

/** The release under which the pass was actually issued, not the latest release head. */
export type IssuedPassEmailRelease = Pick<
  ReleaseRow,
  'id' | 'generation' | 'version' | 'templateId' | 'orgId' | 'mode' | 'provider' | 'candidateHash'
>;

export const PassEmailIntentSchema = z.object({
  format: z.literal(1),
  to: z.string(),
  attach: z.boolean(),
  issuanceId: z.string().optional(),
  /** Who queued it; checked again when the mail goes out. Always written; absent only on rows queued before the cutover. */
  actor: DeliveryActorSchema.optional(),
  /** The second authority of a two-authority request. */
  also: DeliveryActorSchema.optional(),
  pass: PassDeliveryBindingSchema,
});

export async function bindPass(pass: ExpectedPassDelivery): Promise<PassDeliveryBinding> {
  return {
    passId: pass.id,
    orgId: pass.orgId,
    mode: pass.mode,
    testDataQuarantined: pass.testDataQuarantined,
    holderEmail: pass.holderEmail,
    ownerUserId: pass.ownerUserId,
    version: pass.version,
    identityId: pass.identityId,
    credentialGeneration: pass.credentialGeneration,
    lifecycleGeneration: pass.lifecycleGeneration,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    releaseId: pass.releaseId,
    webServiceUrl: pass.webServiceUrl,
    linkGeneration: pass.linkGeneration,
    objectKey: pass.objectKey,
    downloadTokenHash: await sha256Hex(pass.downloadToken),
    status: pass.status,
    removedAt: pass.removedAt,
  };
}

/**
 * Authority fields only: the recipient, owner, identity and generations. A publish or refresh moves
 * version, object key and release without changing who may receive the pass, so those (and the
 * download token, which rotates with the link generation) are read fresh when the mail is built.
 */
export function matchesPass(pass: ExpectedPassDelivery, binding: PassDeliveryBinding): boolean {
  return (
    pass.id === binding.passId &&
    pass.orgId === binding.orgId &&
    pass.mode === binding.mode &&
    !pass.testDataQuarantined &&
    !binding.testDataQuarantined &&
    pass.holderEmail === binding.holderEmail &&
    pass.ownerUserId === binding.ownerUserId &&
    pass.identityId === binding.identityId &&
    pass.credentialGeneration === binding.credentialGeneration &&
    pass.lifecycleGeneration === binding.lifecycleGeneration &&
    pass.templateId === binding.templateId &&
    pass.linkGeneration === binding.linkGeneration &&
    pass.status === binding.status &&
    pass.removedAt === binding.removedAt
  );
}
