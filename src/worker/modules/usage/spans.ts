/** A Live pass counts 90 days after its last use, unless something ends the span sooner (AD10). */
export const SPAN_IDLE_MS = 90 * 86_400_000;

export const SPAN_END_REASONS = [
  'expiry',
  'void',
  'removal',
  'deletion',
  'unregistered',
  'idle',
] as const;
export type SpanEndReason = (typeof SPAN_END_REASONS)[number];

export type SpanPlatform = 'apple' | 'google' | 'samsung' | 'web';

export interface LiveSpan {
  id: string;
  orgId: string;
  passId: string;
  platform: SpanPlatform;
  liveFrom: number;
  liveTo: number | null;
  endReason: SpanEndReason | null;
  expiresAt: number | null;
  lastUsedAt: number;
}
