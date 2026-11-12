import { GoogleWalletError } from './google-errors.ts';

export type GoogleJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GoogleJsonValue[]
  | { readonly [key: string]: GoogleJsonValue };

/** Only pass a projection already approved by the caller's policy boundary. */
export type GoogleGenericProjection = {
  readonly [key: string]: GoogleJsonValue | undefined;
  readonly id?: never;
  readonly classId?: never;
};

export function copyGoogleProjection(projection: GoogleGenericProjection): Record<string, unknown> {
  try {
    if (
      !projection ||
      typeof projection !== 'object' ||
      Array.isArray(projection) ||
      'id' in projection ||
      'classId' in projection
    ) {
      throw new Error();
    }
    // A JSON round-trip removes prototypes and prevents a toJSON method from replacing our IDs.
    const copy: unknown = JSON.parse(JSON.stringify(projection));
    if (
      !copy ||
      typeof copy !== 'object' ||
      Array.isArray(copy) ||
      'id' in copy ||
      'classId' in copy
    ) {
      throw new Error();
    }
    return copy as Record<string, unknown>;
  } catch {
    throw new GoogleWalletError('invalid_input', 'projection');
  }
}
