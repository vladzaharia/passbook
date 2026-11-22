import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { RuleAnchor, RuleOffset } from '../../../shared/contracts/message-rules.ts';
import { RULE_COPY } from '../../../shared/copy/message-rules.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveModeTemplate } from '../broadcasts/target-release.ts';
import type { AnchorInputKind } from './windows.ts';

/** `date` or `date-time` when the input is a string of that format; null otherwise. */
export function anchorKindOf(manifest: TemplateManifest, input: string): AnchorInputKind | null {
  const schema = manifest.inputs.properties?.[input] as
    | { type?: unknown; format?: unknown }
    | undefined;
  if (schema?.type !== 'string') return null;
  return schema.format === 'date' || schema.format === 'date-time' ? schema.format : null;
}

/**
 * Every template must exist in the org, have a message field, and (for an input anchor) a date
 * input of one kind. Returns that kind; a last-scan rule has no input and reads as `date-time`.
 */
export async function checkRuleTemplates(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  templateIds: readonly string[],
  anchor: RuleAnchor,
  offset: RuleOffset,
  light = false,
): Promise<AnchorInputKind> {
  const kinds = new Set<AnchorInputKind>();
  for (const templateId of templateIds) {
    const { manifest } = (await resolveModeTemplate(ctx, orgId, templateId, mode, light)).template;
    if (!manifest.messaging)
      throw new ValidationError(
        `${manifest.name} has no message field.`,
        [],
        'MESSAGING_UNSUPPORTED',
      );
    if (anchor.kind !== 'input') continue;
    const kind = anchorKindOf(manifest, anchor.input);
    if (!kind)
      throw new ValidationError(
        `${manifest.name} has no ${anchor.input}.`,
        [{ path: 'anchor', message: 'Pick a date input.' }],
        'RULE_INPUT_MISSING',
      );
    kinds.add(kind);
  }
  if (kinds.size > 1)
    throw new ValidationError(
      'The date input is a date on one template and a date and time on another.',
      [{ path: 'anchor', message: 'Use templates whose input is the same kind.' }],
      'RULE_INPUT_MISMATCH',
    );
  const kind = [...kinds][0] ?? 'date-time';
  if (offset.unit === 'hour' && kind !== 'date-time')
    throw new ValidationError(
      RULE_COPY.hoursNeedDateTime,
      [{ path: 'offset', message: RULE_COPY.hoursNeedDateTime }],
      'RULE_HOURS_NEED_DATETIME',
    );
  return kind;
}
