import { ValidationError } from '../../platform/errors.ts';

/** Admit One (`starter`) always shows the PassBook footer; there is no add-on that removes it. */
export function assertFooterAllowed(preset: string, mark: unknown): void {
  if (preset === 'starter' && mark === 'none')
    throw new ValidationError(
      'Admit One keeps the PassBook footer. Choose a plan that allows removing it.',
      [{ path: 'values.brand.mark', message: 'Not allowed on this plan.' }],
      'FOOTER_REQUIRED',
    );
}
