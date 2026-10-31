import type { PassJson, PassStyle } from '../../passkit/types.ts';

/** Workstream b owns this module. Keep `normalize`, `NormalizeOptions` and `PassView` exported. */
export interface NormalizeOptions {
  /** Asset file name (e.g. `logo@2x.png`, `en.lproj/strip.png`) → URL the browser can load. */
  assets: Record<string, string>;
  locale?: string;
  strings?: Record<string, string>;
  now?: Date;
}

export interface PassView {
  style: PassStyle;
  organizationName: string;
  description: string;
  voided: boolean;
  expired: boolean;
}

export function normalize(pass: PassJson, options: NormalizeOptions): PassView {
  const style =
    (
      ['posterGeneric', 'boardingPass', 'coupon', 'eventTicket', 'storeCard', 'generic'] as const
    ).find((s) => pass[s] !== undefined) ?? 'generic';
  const now = options.now ?? new Date();
  return {
    style,
    organizationName: String(pass.organizationName ?? ''),
    description: String(pass.description ?? ''),
    voided: pass.voided === true,
    expired: typeof pass.expirationDate === 'string' && new Date(pass.expirationDate) < now,
  };
}
