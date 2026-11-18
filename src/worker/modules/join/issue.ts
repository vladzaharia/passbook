import { validateInput } from '../../../passkit/build.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization } from '../../../passkit/types.ts';
import { revealToken } from '../../platform/capability-token.ts';
import type { Ids } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { createPassRow } from '../passes/create.ts';
import type { JoinKeys } from '../passes/create-types.ts';
import { activeRelease } from '../templates/releases.ts';
import { type JoinReadiness, joinReadiness } from './readiness.ts';
import type { PublicLink } from './repo-issues.ts';

/** The release a public card is built on and what the form asks of it; null when the link cannot open. */
export interface OpenRelease {
  version: string;
  readiness: JoinReadiness;
  template: Awaited<ReturnType<typeof resolveTemplate>>;
}

/** The active release of the link's mode (never another mode's) when it can take public sign-ups. */
export async function openRelease(
  ctx: ServiceContext,
  link: PublicLink,
): Promise<OpenRelease | null> {
  const release = await activeRelease(ctx, link.templateId, link.orgId, link.mode, 'apple');
  if (!release) return null;
  const template = await resolveTemplate(ctx, link.orgId, link.templateId, release.version);
  const readiness = joinReadiness(template.manifest, link.nameInput);
  return readiness.issues.length > 0 ? null : { version: release.version, readiness, template };
}

/** Ten random digits, zero padded. */
const tenDigits = (ids: Ids) => ids.code(10);

/**
 * The only inputs a public card has: each top-level schema default, the name in the one input the link
 * asks it for, and a generated ten-digit value for every required input nobody asks. Nothing comes from the
 * template's sample or from any other form field. Throws a build error when the schema still refuses it.
 */
export function assembleInput(
  open: OpenRelease,
  name: string | undefined,
  ids: Ids,
): Personalization {
  const { readiness, template } = open;
  const input = applyDefaults(template.manifest, {});
  if (readiness.nameInput !== null && name !== undefined) input[readiness.nameInput] = name;
  for (const g of readiness.generated) input[g.key] = tenDigits(ids);
  validateInput(template, input);
  return input;
}

export interface JoinCard {
  /** The plain download token of the new pass: `/p/<token>`. */
  token: string;
}

/** Builds, signs and stores the card under the link's grant; the caps and the duplicate rule commit with it. */
export async function createJoinCard(
  ctx: ServiceContext,
  link: PublicLink,
  open: OpenRelease,
  input: Personalization,
  o: { email: string | null; mail: boolean; orgDailyCap: number; keys: JoinKeys },
): Promise<JoinCard> {
  const pass = await createPassRow(ctx, {
    orgId: link.orgId,
    templateId: link.templateId,
    templateVersion: open.version,
    input,
    holderEmail: o.email,
    sendEmail: o.mail && o.email !== null,
    source: 'manual',
    mode: link.mode,
    execution: {
      kind: 'join',
      linkId: link.id,
      generation: link.generation,
      orgDailyCap: o.orgDailyCap,
    },
    actor: { type: 'system', id: `join:${link.id}` },
    joinKeys: o.keys,
  });
  return { token: await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken) };
}
