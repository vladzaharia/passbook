import {
  type SetupGuide,
  type SetupGuideInput,
  SetupGuideSchema,
} from '../../../../shared/contracts/connection-setup.ts';

/** Applies the schema's defaults and fails at load on a malformed guide. */
export const defineGuide = (guide: SetupGuideInput): SetupGuide => SetupGuideSchema.parse(guide);

/** The content date of the first guides. A change to a guide's steps moves its own `version`. */
export const CHECKED_AT = '2026-11-25';
