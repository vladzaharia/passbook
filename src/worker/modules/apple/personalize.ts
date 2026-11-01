import { z } from 'zod';
import { signManifest } from '../../../passkit/sign/index.ts';
import type { TemplateRegistry } from '../../../passkit/template/registry.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isOrgActive } from '../orgs/active.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { depsOf } from '../passes/deps.ts';
import { publishPass } from '../passes/publish.ts';
import { getPassBySerial } from '../passes/repo.ts';
import { withoutPersonalizationFiles } from './personalize-files.ts';
import {
  getPersonalization,
  insertPersonalization,
  markPersonalizationPublished,
} from './personalize-repo.ts';
import { identityByPassType } from './repo.ts';

const text = (max: number) => z.string().max(max).optional();

/** Apple's PersonalizationDictionary. */
export const PersonalizationDictionarySchema = z.object({
  // Wallet picks the token and it is signed verbatim. Any JSON container needs { or [, so a
  // JSON-shaped token (a forged manifest.json) is refused here, before any lookup or signing.
  personalizationToken: z
    .string()
    .min(1)
    .max(512)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    .regex(/^[^{}[\]"\\\s\u0000-\u001f\u007f-\u009f]+$/),
  requiredPersonalizationInfo: z.object({
    fullName: text(200),
    givenName: text(100),
    familyName: text(100),
    emailAddress: text(254),
    phoneNumber: text(50),
    postalCode: text(20),
    ISOCountryCode: text(2),
  }),
});
type Info = z.infer<typeof PersonalizationDictionarySchema>['requiredPersonalizationInfo'];

const FIELD_KEYS: Record<string, (info: Info) => unknown> = {
  PKPassPersonalizationFieldName: (i) => i.fullName || (i.givenName && i.familyName),
  PKPassPersonalizationFieldPostalCode: (i) => i.postalCode,
  PKPassPersonalizationFieldEmailAddress: (i) => i.emailAddress,
  PKPassPersonalizationFieldPhoneNumber: (i) => i.phoneNumber,
};

const unavailable = () => new NotFoundError('Not found.', 'PERSONALIZATION_UNAVAILABLE');

async function requiredFields(
  registry: TemplateRegistry,
  template: Awaited<ReturnType<typeof resolveTemplate>>,
): Promise<string[] | null> {
  if (!template.assets.some((a) => a.name === 'personalization.json')) return null;
  const raw = await new Response(await registry.openAsset(template, 'personalization.json')).text();
  const parsed = JSON.parse(raw) as { requiredPersonalizationFields?: unknown };
  return Array.isArray(parsed.requiredPersonalizationFields)
    ? parsed.requiredPersonalizationFields.filter((f): f is string => typeof f === 'string')
    : [];
}

/**
 * POST .../personalize. Wallet sends no ApplePass header here, so the pass is found by
 * (pass type, serial) alone; the serial is the capability. Stores the holder info (encrypted),
 * republishes the pass without personalization.json and returns the token as a detached
 * PKCS#7 signature made with the pass certificate.
 */
export async function personalize(
  ctx: ServiceContext,
  input: { passTypeId: string; serial: string; body: unknown },
): Promise<Uint8Array> {
  const db = ctx.env.DB;
  const parsed = PersonalizationDictionarySchema.safeParse(input.body);
  if (!parsed.success) {
    ctx.log.warn('apple.personalize_refused', { code: 'PERSONALIZATION_INVALID' });
    throw new BadRequestError('Invalid personalization.', 'PERSONALIZATION_INVALID');
  }
  const identity = await identityByPassType(db, input.passTypeId);
  const pass = identity ? await getPassBySerial(db, identity.id, input.serial) : null;
  if (
    !identity ||
    !pass ||
    pass.deletedAt !== null ||
    pass.status === 'voided' ||
    !identity.nfcEnabled ||
    !(await isOrgActive(ctx, pass.orgId))
  )
    throw unavailable();
  const deps = depsOf(ctx.env);
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  const required = await requiredFields(deps.registry, template);
  if (!required) throw unavailable();

  const { personalizationToken: token, requiredPersonalizationInfo: info } = parsed.data;
  if (required.some((f) => FIELD_KEYS[f] && !FIELD_KEYS[f](info)))
    throw new BadRequestError(
      'Required personalization fields are missing.',
      'PERSONALIZATION_INCOMPLETE',
    );

  const tokenHash = await sha256Hex(token);
  let row = await getPersonalization(db, pass.id);
  if (row && row.tokenSha256 !== tokenHash)
    throw new ConflictError('This pass is already personalized.', 'ALREADY_PERSONALIZED');
  if (!row) {
    const envelope = await encryptSecret(
      await loadKekRing(ctx.env),
      JSON.stringify(info),
      credentialAad(pass.id, pass.orgId, 'personalization'),
    );
    const stored = await insertPersonalization(db, {
      passId: pass.id,
      tokenSha256: tokenHash,
      envelope,
      now: ctx.clock.now(),
    });
    row = await getPersonalization(db, pass.id);
    if (!row || row.tokenSha256 !== tokenHash)
      throw new ConflictError('This pass is already personalized.', 'ALREADY_PERSONALIZED');
    if (stored)
      await recordAudit(ctx, {
        orgId: pass.orgId,
        actorType: 'device',
        action: 'pass.personalized',
        targetType: 'pass',
        targetId: pass.id,
        detail: { fields: required },
      });
  }

  // Retried requests republish until one succeeds.
  if (row.publishedAt === null) {
    await publishPass(withoutPersonalizationFiles(ctx), {
      passId: pass.id,
      cause: 'user_refresh',
      actor: { type: 'system', id: null },
      force: true,
    });
    await markPersonalizationPublished(db, pass.id, ctx.clock.now());
  }

  const resolved = await deps.identities.byId(identity.id);
  return signManifest(new TextEncoder().encode(token), resolved.material, {
    now: new Date(ctx.clock.now()),
    expectedIdentity: {
      passTypeIdentifier: resolved.passTypeIdentifier,
      teamIdentifier: resolved.teamIdentifier,
    },
  });
}
