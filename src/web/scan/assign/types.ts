/**
 * The tag API as the client uses it: shapes come from `contracts/nfc-tags.ts`. The enrollment
 * calls (T5) are built against that contract and may still move.
 */
import type { z } from 'zod';
import type { ScanTagEnrollmentDoneSchema } from '../../../shared/contracts/nfc-tag-admin.ts';
import type {
  ScanTag,
  ScanTagBindRequestSchema,
  ScanTagBindResultSchema,
  ScanTagEnrollmentSchema,
  ScanTagInspectResponseSchema,
  TagRead,
} from '../../../shared/contracts/nfc-tags.ts';

export type { ScanTag, TagRead };
export type TagPass = NonNullable<ScanTag['passes']>[number];
export type InspectResult = z.infer<typeof ScanTagInspectResponseSchema>;
export type BindResult = z.infer<typeof ScanTagBindResultSchema>;
export type BindBody = z.input<typeof ScanTagBindRequestSchema>;
export type EnrollDone = z.infer<typeof ScanTagEnrollmentDoneSchema>;
export type TagEnrollment = z.infer<typeof ScanTagEnrollmentSchema>;

/** The calls the assign loop and the enrollment sheet make. A rejection is an `ApiError`. */
export interface TagsPort {
  inspect(body: { tag: TagRead }, o: { signal: AbortSignal }): Promise<InspectResult>;
  bind(body: BindBody, o: { signal: AbortSignal }): Promise<BindResult>;
  undo(bindingId: string, o: { signal: AbortSignal }): Promise<void>;
  pending(o: { signal: AbortSignal }): Promise<TagEnrollment | null>;
  complete(id: string, body: { tag: TagRead }, o: { signal: AbortSignal }): Promise<EnrollDone>;
  decline(id: string, o: { signal: AbortSignal }): Promise<void>;
}
