import { FEATURES_KEPT, impactSentence } from '@/shared/copy/entitlement-admin.ts';
import { type EntitlementImpact, reducing } from '@/shared/entitlement-impact.ts';
import type { ConfirmCopy } from './confirms.ts';

/** What a change takes away is spelled out; nothing the org made is ever deleted. */
const describe = (impact: EntitlementImpact) =>
  reducing(impact) > 0 ? `${impactSentence(impact)} ${FEATURES_KEPT}` : impactSentence(impact);

/** Moving an organization to another preset; its overrides stay. */
export function applyPresetConfirm(
  preset: string,
  orgName: string,
  impact: EntitlementImpact,
): ConfirmCopy {
  return {
    title: `Apply ${preset} to ${orgName}?`,
    confirmLabel: 'Apply',
    description: describe(impact),
    typed: false,
  };
}

/** A preset's value changed: every organization on it moves with it. */
export function editPresetConfirm(
  preset: string,
  orgCount: number,
  impact: EntitlementImpact,
): ConfirmCopy {
  const moves =
    orgCount === 0
      ? 'No organization is on it.'
      : `Moves ${orgCount} ${orgCount === 1 ? 'organization' : 'organizations'}.`;
  return {
    title: `Change ${preset}?`,
    confirmLabel: 'Change',
    description: `${moves} ${describe(impact)}`,
    typed: false,
  };
}

/** One feature set by hand, for as long as the override stands. */
export function overrideConfirm(feature: string, impact: EntitlementImpact): ConfirmCopy {
  return {
    title: `Override ${feature}?`,
    confirmLabel: 'Override',
    description: describe(impact),
    typed: false,
  };
}

/** Dropping an override: the feature returns to what the preset gives. */
export function resetOverrideConfirm(
  feature: string,
  preset: string,
  impact: EntitlementImpact,
): ConfirmCopy {
  return {
    title: `Reset ${feature} to ${preset}?`,
    confirmLabel: 'Reset',
    description: describe(impact),
    typed: false,
  };
}

/** The first preset of an organization with no features set. */
export function firstPresetConfirm(preset: string, orgName: string): ConfirmCopy {
  return {
    title: `Apply ${preset} to ${orgName}?`,
    confirmLabel: 'Apply',
    description: 'Sets its features for the first time.',
    typed: false,
  };
}
