import { z } from 'zod';

/** `idColumn` is a JSON pointer into a row (`/Member ID`); it keys every pass, so it never changes. */
export const config = z.object({
  idColumn: z
    .string()
    .min(1)
    .max(500)
    .regex(/^(?:\/(?:[^~/]|~[01])*)+$/, 'Not a JSON pointer.')
    .meta({
      'x-label': 'ID column',
      'x-help': 'The column that names each row. Rows with no ID, or a repeated one, are skipped.',
      'x-order': 1,
    }),
});

export type Config = z.infer<typeof config>;
